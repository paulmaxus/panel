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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'holoviews', 'colorcet', 'hvplot']
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


import numpy as np
import pandas as pd
import holoviews as hv
import panel as pn

from colorcet import bmy

pn.extension('tabulator', template='fast')
import hvplot.pandas


# ## Create intro

# In[ ]:


instruction = pn.pane.Markdown("""
This dashboard visualizes all global glaciers and allows exploring the relationships
between their locations and variables such as their elevation, temperature and annual
precipitation.<br><br>Box- or lasso-select on each plot to subselect and hit the 
"Clear selection" button to reset. See the notebook source code for how to build apps
like this!""", width=600)

panel_logo = pn.pane.PNG(
    'https://panel.holoviz.org/_static/logo_stacked.png',
    link_url='https://panel.holoviz.org', height=95, align='center'
)

oggm_logo = pn.pane.PNG(
    'https://raw.githubusercontent.com/OGGM/oggm/master/docs/_static/logos/oggm_s_alpha.png',
    link_url='https://oggm.org/', height=100, align='center'
)

intro = pn.Row(
    oggm_logo,
    instruction,
    pn.layout.HSpacer(),
    panel_logo,
    sizing_mode='stretch_width'
)

intro


# ### Load and cache data

# In[ ]:


from holoviews.element.tiles import lon_lat_to_easting_northing

@pn.cache
def load_data():
    df = pd.read_parquet('https://datasets.holoviz.org/oggm_glaciers/v1/oggm_glaciers.parq')
    df['latdeg'] = df.cenlat
    df['x'], df['y'] = lon_lat_to_easting_northing(df.cenlon, df.cenlat)
    return df

df = load_data()

df.tail()


# ### Set up linked selections

# In[ ]:


ls = hv.link_selections.instance()

def clear_selections(event):
    ls.selection_expr = None

clear_button = pn.widgets.Button(name='Clear selection', align='center')

clear_button.param.watch(clear_selections, 'clicks');

total_area = df.area_km2.sum()

def count(data):
    selected_area  = np.sum(data['area_km2'])
    selected_percentage = selected_area / total_area * 100
    return f'## Glaciers selected: {len(data)} | Area: {selected_area:.0f} km² ({selected_percentage:.1f}%)</font>'

pn.Row(
    pn.pane.Markdown(pn.bind(count, ls.selection_param(df)), align='center', width=600),
    clear_button
).servable(area='header', title='OGGM Glaciers')


# ### Create plots

# In[ ]:


geo = df.hvplot.points(
    'x', 'y', rasterize=True, tools=['hover'], tiles='ESRI', cmap=bmy, logz=True, colorbar=True,
    xaxis=None, yaxis=False, ylim=(-7452837.583633271, 6349198.00989753), min_height=400, responsive=True
).opts('Tiles', alpha=0.8)

scatter = df.hvplot.scatter(
    'avg_prcp', 'mean_elev', rasterize=True, fontscale=1.2, grid=True,
    xlabel='Avg. Precipitation', ylabel='Elevation', responsive=True, min_height=400
)

temp = df.hvplot.hist(
    'avg_temp_at_mean_elev', fontscale=1.2, responsive=True, min_height=350, fill_color='#85c1e9'
)

precipitation = df.hvplot.hist(
    'avg_prcp', fontscale=1.2, responsive=True, min_height=350, fill_color='#f1948a'
)

plots = pn.pane.HoloViews(ls(geo + scatter + temp + precipitation).cols(2).opts(sizing_mode='stretch_both'))
plots


# ## Dashboard content
# 

# In[ ]:


pn.Column(intro, plots, sizing_mode='stretch_both').servable();



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