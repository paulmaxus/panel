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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'param', 'pandas']
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

from bokeh.sampledata.autompg import autompg_clean

from bokeh.sampledata.population import data

from panel.viewable import Viewer



pn.extension(template='fast')

pn.pane.Markdown("\\nThis example demonstrates Panel's reactive programming paradigm using the Param library to express parameters, plus methods with computation depending on those parameters. This pattern can be used to update the displayed views whenever a parameter value changes, without re-running computation unnecessarily.\\n\\n").servable()

class ReactiveTables(Viewer):



    dataset = param.ObjectSelector(default='iris', objects=['iris', 'autompg', 'population'])



    rows = param.Integer(default=10, bounds=(0, 19))



    @param.depends('dataset')

    def data(self):

        if self.dataset == 'iris':

            return flowers

        elif self.dataset == 'autompg':

            return autompg_clean

        else:

            return data



    @param.depends('data')

    def summary(self):

        return self.data().describe()



    @param.depends('data', 'rows')

    def table(self):

        return self.data().iloc[:self.rows]



    def __panel__(self):

        return pn.Row(

            pn.Param(self, name="Settings", width=300),

			pn.Spacer(width=10),

            pn.Column(

			    "## Description",

				pn.pane.DataFrame(self.summary, sizing_mode='stretch_width'),

				"## Table",

				pn.pane.DataFrame(self.table, sizing_mode='stretch_width'),

			)

        )



ReactiveTables().servable()

pn.state.template.title = 'Reactive Tables'

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