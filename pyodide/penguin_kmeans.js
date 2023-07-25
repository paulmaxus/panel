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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'altair']
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


import altair as alt
import panel as pn
import pandas as pd

from sklearn.cluster import KMeans

pn.extension('tabulator', 'vega', design='material', template='material')


# ## Load data

# In[ ]:


penguins = pn.cache(pd.read_csv)('https://datasets.holoviz.org/penguins/v1/penguins.csv').dropna()
cols = list(penguins.columns)[2:6]


# ## Define application

# In[ ]:


@pn.cache
def get_clusters(n_clusters):
    kmeans = KMeans(n_clusters=n_clusters, n_init='auto')
    est = kmeans.fit(penguins[cols].values)
    df = penguins.copy()
    df['labels'] = est.labels_.astype('str')
    return df

@pn.cache
def get_chart(x, y, df):
    centers = df.groupby('labels')[[x] if x == y else [x, y]].mean()
    return (
        alt.Chart(df)
            .mark_point(size=100)
            .encode(
                x=alt.X(x, scale=alt.Scale(zero=False)),
                y=alt.Y(y, scale=alt.Scale(zero=False)),
                shape='labels',
                color='species'
            ).add_params(brush) +
        alt.Chart(centers)
            .mark_point(size=250, shape='cross', color='black')
            .encode(x=x+':Q', y=y+':Q')
    ).properties(width='container', height='container')

intro = pn.pane.Markdown("""
This app provides an example of **building a simple dashboard using
Panel**.\\n\\nIt demonstrates how to take the output of **k-means
clustering on the Penguins dataset** using scikit-learn,
parameterizing the number of clusters and the variables to
plot.\\n\\nThe plot and the table are linked, i.e. selecting on the plot
will filter the data in the table.\\n\\n The **\`x\` marks the center** of
the cluster.
""")

x = pn.widgets.Select(name='x', options=cols, value='bill_depth_mm')
y = pn.widgets.Select(name='y', options=cols, value='bill_length_mm')
n_clusters = pn.widgets.IntSlider(name='n_clusters', start=1, end=5, value=3)

brush = alt.selection_interval(name='brush')  # selection of type "interval"

clusters = pn.bind(get_clusters, n_clusters)

chart = pn.pane.Vega(
    pn.bind(get_chart, x, y, clusters), min_height=400, max_height=800, sizing_mode='stretch_width'
)

table = pn.widgets.Tabulator(
    clusters,
    pagination='remote', page_size=10, height=600,
    sizing_mode='stretch_width'
)

def vega_filter(filters, df):
    filtered = df
    for field, drange in (filters or {}).items():
        filtered = filtered[filtered[field].between(*drange)]
    return filtered

table.add_filter(pn.bind(vega_filter, chart.selection.param.brush))


# ## Layout app

# In[ ]:


pn.Row(
    pn.Column(x, y, n_clusters).servable(area='sidebar'),
    pn.Column(
        intro, chart, table,
    ).servable(title='KMeans Clustering'),
    sizing_mode='stretch_both',
    min_height=1000
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