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

import param

import panel as pn



from bokeh.sampledata.iris import flowers

from panel.viewable import Viewer



pn.extension(template='fast')

import hvplot.pandas

pn.pane.Markdown('\\nThis example demonstrates the use of a \`Viewer\` class to build a reactive app. It uses the [iris dataset](https://en.wikipedia.org/wiki/Iris_flower_data_set) which is a standard example used to illustrate machine-learning and visualization techniques.\\n\\nWe will start by using the dataframe with these five features and then create a \`Selector\` parameter to develop menu options for different input features. Later we will define the core plotting function in a \`plot\` method and define the layout in the \`__panel__\` method of the \`IrisDashboard\` class.\\n\\nThe \`plot\` method watches the \`X_variable\` and \`Y_variable\` using the \`param.depends\` [decorator](https://www.google.com/search?q=python+decorator). The \`plot\` method plots the features selected for \`X_variable\` and \`Y_variable\` and colors them using the \`species\` column.\\n\\n').servable()

inputs = ['sepal_length', 'sepal_width', 'petal_length', 'petal_width']



class IrisDashboard(Viewer):

    X_variable = param.Selector(objects=inputs, default=inputs[0])

    Y_variable = param.Selector(objects=inputs, default=inputs[1])



    @param.depends('X_variable', 'Y_variable')

    def plot(self):

        return flowers.hvplot.scatter(x=self.X_variable, y=self.Y_variable, by='species').opts(height=600)



    def __panel__(self):

        return pn.Row(

            pn.Param(self, width=300, name="Plot Settings"),

            self.plot

        )



IrisDashboard(name='Iris_Dashboard').servable()

pn.state.template.title = 'Plot Viewer'

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