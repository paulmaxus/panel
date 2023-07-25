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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'param', 'requests']
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

import panel as pn

import param

import requests



class BasicVueComponent(pn.reactive.ReactiveHTML):



    _template = """

    <div id="container" style="height:100%; width:100%; background:#0072B5; border-radius:4px; padding:6px; color:white">

      <vue-component></vue-component>

    </div>

    """



    _scripts = {

        "render": """

    const template = "<div>Hello Panel + Vue.js World!</div>"

    const vue_component = {template: template}

    el=new Vue({

        el: container,

        components: {

            'vue-component' : vue_component

        }

    })

    """

    }



    _extension_name = 'vue'



    __javascript__ = [

        "https://cdn.jsdelivr.net/npm/vue@2/dist/vue.js"

    ]



class BootstrapVueComponent(BasicVueComponent):



    __javascript__= [

        "https://cdn.jsdelivr.net/npm/vue@2/dist/vue.js",

        "https://unpkg.com/bootstrap-vue@latest/dist/bootstrap-vue.min.js",

    ]

    __css__=[

        "https://unpkg.com/bootstrap/dist/css/bootstrap.min.css",

        "https://unpkg.com/bootstrap-vue@latest/dist/bootstrap-vue.min.css",

    ]



pn.extension('vue', sizing_mode="stretch_width", template="bootstrap")

pn.pane.Markdown('\\nIn this example we are building a Vue.js component containing an input field and a button that will update the \`value\` parameter of the \`PDBInput\` component:\\n\\n').servable()



class PDBInput(BootstrapVueComponent):



    value = param.String()



    _template = """

    <div id="container" style="height:100%; width:100%">

      <vue-component></vue-component>

    </div>

    """



    _scripts = {

        "render": """

    const template = \`

    <div>

      <b-form v-on:keydown.enter.prevent>

        <b-form-input v-model="pdb_id" placeholder="Enter PDB ID" required></b-form-input>

        <b-button variant="secondary" size="sm" v-on:click="setPDBId" style="margin-top:10px;width:100%">

            Retrieve PDB metadata

        </b-button>

      </b-form>

    </div>\`

    const vue_component = {

      template: template,

      delimiters: ['[[', ']]'],

      data: function () {

        return {

          pdb_id: data.value,

        }

      },

      methods: {

        setPDBId() {

          data.value = this.pdb_id

        }

      }

    }

    const el = new Vue({

        el: container,

        components: {

            'vue-component': vue_component

        }

    })

    """

    }

pn.pane.Markdown('\\n## Featurize Protein Structure\\n\\nUse the Vue component below to retrieve PDB metadata from [KLIFS](https://klifs.net/). For example for *\`2xyu\`* or *\`4WSQ\`*:\\n\\n').servable()

URL = "https://klifs.net/api/structures_pdb_list"



def get_pdb_data_from_klifs(pdb_id):

    if not pdb_id:

        return "Please specify a PDB ID."



    params = {'pdb-codes': pdb_id}

    res = requests.get(url = URL, params = params)

    data = res.json()



    if res.status_code == 400:

        return f"Error 400, Could not get PDB {pdb_id}", data[1]



    return data[0]



pdb_input = PDBInput(height=90, max_width=800)



iget_klifs_data = pn.bind(get_pdb_data_from_klifs, pdb_id=pdb_input.param.value)



pn.Column(

    pdb_input,

    pn.pane.JSON(iget_klifs_data, theme="light")

).servable()

pn.state.template.title = 'Wrap a Vue component'

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