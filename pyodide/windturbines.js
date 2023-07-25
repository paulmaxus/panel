importScripts("https://cdn.jsdelivr.net/pyodide/v0.23.4/pyc/pyodide.js");

function sendPatch(patch, buffers, msg_id) {
  self.postMessage({
    type: 'patch',
    patch: patch,
    buffers: buffers
  })
}

async function startApplication() {
  console.log("Loading pyodide!");
  self.postMessage({type: 'status', msg: 'Loading pyodide'})
  self.pyodide = await loadPyodide();
  self.pyodide.globals.set("sendPatch", sendPatch);
  console.log("Loaded!");
  await self.pyodide.loadPackage("micropip");
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'hvplot', 'fastparquet']
  for (const pkg of env_spec) {
    let pkg_name;
    if (pkg.endsWith('.whl')) {
      pkg_name = pkg.split('/').slice(-1)[0].split('-')[0]
    } else {
      pkg_name = pkg
    }
    self.postMessage({type: 'status', msg: `Installing ${pkg_name}`})
    try {
      await self.pyodide.runPythonAsync(`
        import micropip
        await micropip.install('${pkg}');
      `);
    } catch(e) {
      console.log(e)
      self.postMessage({
	type: 'status',
	msg: `Error while installing ${pkg_name}`
      });
    }
  }
  console.log("Packages loaded!");
  self.postMessage({type: 'status', msg: 'Executing code'})
  const code = `
  
import asyncio

from panel.io.pyodide import init_doc, write_doc

init_doc()

#!/usr/bin/env python
# coding: utf-8

# In[ ]:


import holoviews as hv
import panel as pn
import pandas as pd

pn.extension('vizzu', 'tabulator', design='material', template='material')
import hvplot.pandas


# ## Load data

# In[ ]:


windturbines = pn.state.as_cached(
    'windturbines',
    pd.read_parquet,
    path='https://datasets.holoviz.org/windturbines/v1/windturbines.parq'
)

windturbines.head()


# ## Plot data

# In[ ]:


def data(df, groupby, quant):
    if quant == 'Count':
        return df.value_counts(groupby).to_frame(name='Count').sort_index().reset_index().iloc[:50]
    else:
        return df.groupby(groupby)[quant].sum().reset_index().iloc[:50]

def config(chart_type, groupby, quant):
    if chart_type == 'Bubble Chart':
        return {
            "channels": {
                "x": None,
                "y": None,
                "color": groupby,
                "label": groupby,
                "size": quant
            },
            'geometry': 'circle'
        }
    else:
        return {
            "channels": {
                "x": groupby,
                "y": quant,
                "color": None,
                "label": None,
                "size": None
            },
            'geometry': 'rectangle'
        }
    
ls = hv.link_selections.instance()

geo = ls(windturbines.hvplot.points(
    'easting', 'northing', xaxis=None, yaxis=None, rasterize=True, xlim=(-15000000, -5000000),
    tiles='CartoLight', height=500, responsive=True, dynspread=True, cnorm='log', cmap='plasma'
))
    
groupby = pn.widgets.RadioButtonGroup(options={'State': 't_state', 'Year': 'p_year', 'Manufacturer': 't_manu'}, align='center')
chart_type = pn.widgets.RadioButtonGroup(options=['Bar Chart', 'Bubble Chart'], align='center')
quant = pn.widgets.RadioButtonGroup(options={'Count': 'Count', 'Capacity': 'p_cap'}, align='center')
lsdata = ls.selection_param(windturbines)

vizzu = pn.pane.Vizzu(
    pn.bind(data, lsdata, groupby, quant),
    config=pn.bind(config, chart_type, groupby, quant),
    column_types={'p_year': 'dimension'},
    style={
        "plot": {
            "xAxis": {
                "label": {
                    "angle": "-45deg"
                }
            }
        }
    },
    sizing_mode='stretch_both'
)

def format_df(df):
    df = df[['t_state', 't_county', 'p_name', 'p_year', 't_manu', 't_cap']]
    return df.rename(
        columns={col: col.split('_')[1].title() for col in df.columns}
    )


table = pn.widgets.Tabulator(
    pn.bind(format_df, lsdata), page_size=8, pagination='remote',
    show_index=False,
)

pn.Column(
    pn.Row(quant, "# by", groupby, "# as a", chart_type).servable(area='header'),
    pn.Column(
        pn.Row(geo, table),
        vizzu, min_height=1000,
        sizing_mode='stretch_both'
    ).servable(title='Windturbines')
)



await write_doc()
  `

  try {
    const [docs_json, render_items, root_ids] = await self.pyodide.runPythonAsync(code)
    self.postMessage({
      type: 'render',
      docs_json: docs_json,
      render_items: render_items,
      root_ids: root_ids
    })
  } catch(e) {
    const traceback = `${e}`
    const tblines = traceback.split('\n')
    self.postMessage({
      type: 'status',
      msg: tblines[tblines.length-2]
    });
    throw e
  }
}

self.onmessage = async (event) => {
  const msg = event.data
  if (msg.type === 'rendered') {
    self.pyodide.runPythonAsync(`
    from panel.io.state import state
    from panel.io.pyodide import _link_docs_worker

    _link_docs_worker(state.curdoc, sendPatch, setter='js')
    `)
  } else if (msg.type === 'patch') {
    self.pyodide.globals.set('patch', msg.patch)
    self.pyodide.runPythonAsync(`
    state.curdoc.apply_json_patch(patch.to_py(), setter='js')
    `)
    self.postMessage({type: 'idle'})
  } else if (msg.type === 'location') {
    self.pyodide.globals.set('location', msg.location)
    self.pyodide.runPythonAsync(`
    import json
    from panel.io.state import state
    from panel.util import edit_readonly
    if state.location:
        loc_data = json.loads(location)
        with edit_readonly(state.location):
            state.location.param.update({
                k: v for k, v in loc_data.items() if k in state.location.param
            })
    `)
  }
}

startApplication()