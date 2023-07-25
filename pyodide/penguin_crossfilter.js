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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'hvplot']
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
import panel as pn

import holoviews as hv
import hvplot.pandas # noqa

pn.extension(template='fast')

pn.state.template.logo = 'https://github.com/allisonhorst/palmerpenguins/raw/main/man/figures/logo.png'


# ## Introduction

# In[ ]:


welcome = "## Welcome and meet the Palmer penguins!"

penguins_art = pn.pane.PNG('https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/man/figures/palmerpenguins.png', height=160)

credit = "### Artwork by @allison_horst"

instructions = """
Use the box-select and lasso-select tools to select a subset of penguins
and reveal more information about the selected subgroup through the power
of cross-filtering.
"""

license = """
### License

Data are available by CC-0 license in accordance with the Palmer Station LTER Data Policy and the LTER Data Access Policy for Type I data."
"""

art = pn.Column(
    welcome, penguins_art, credit, instructions, license,
    sizing_mode='stretch_width'
).servable(area='sidebar')

art


# ## Building some plots
# 
# Let us first load the Palmer penguin dataset ([Gorman et al.](https://allisonhorst.github.io/palmerpenguins/)) which contains measurements about a number of penguin species:

# In[ ]:


penguins = pd.read_csv('https://datasets.holoviz.org/penguins/v1/penguins.csv')
penguins = penguins[~penguins.sex.isnull()].reset_index().sort_values('species')

penguins


# Next we will set up a linked selections instance that will allow us to perform cross-filtering on the plots we will create in the next step:

# In[ ]:


ls = hv.link_selections.instance()

def count(selected):
    return f"## {len(selected)}/{len(penguins)} penguins selected"

selected = pn.pane.Markdown(
    pn.bind(count, ls.selection_param(penguins)),
    align='center', width=400, margin=(0, 100, 0, 0)
)

header = pn.Row(
    pn.layout.HSpacer(), selected,
    sizing_mode='stretch_width'
).servable(area='header')

selected


# Now we can start plotting the data with hvPlot, which provides a familiar API to pandas \`.plot\` users but generates interactive plots and use the linked selections object to allow cross-filtering across the plots:

# In[ ]:


colors = {
    'Adelie': '#1f77b4',
    'Gentoo': '#ff7f0e',
    'Chinstrap': '#2ca02c'
}

scatter = penguins.hvplot.points(
    'bill_length_mm', 'bill_depth_mm', c='species',
    cmap=colors, responsive=True, min_height=300
)

histogram = penguins.hvplot.hist(
    'body_mass_g', by='species', color=hv.dim('species').categorize(colors),
    legend=False, alpha=0.5, responsive=True, min_height=300
)

bars = penguins.hvplot.bar(
    'species', 'index', c='species', cmap=colors,
    responsive=True, min_height=300, ylabel=''
).aggregate(function=np.count_nonzero)

violin = penguins.hvplot.violin(
    'flipper_length_mm', by=['species', 'sex'], cmap='Category20',
    responsive=True, min_height=300, legend='bottom_right'
).opts(split='sex')

plots = pn.pane.HoloViews(
    ls(scatter.opts(show_legend=False) + bars + histogram + violin).opts(sizing_mode='stretch_both').cols(2)
).servable(title='Palmer Penguins')

plots



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