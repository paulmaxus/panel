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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'param']
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



from panel.reactive import ReactiveHTML



class MaterialBase(ReactiveHTML):



    __javascript__ = ['https://unpkg.com/material-components-web@latest/dist/material-components-web.min.js']



    __css__ = ['https://unpkg.com/material-components-web@latest/dist/material-components-web.min.css']



    _extension_name = 'material_ui'



pn.extension('material_ui', template='material')

pn.pane.Markdown('\\nThis example demonstrates how to wrap Material UI components using \`ReactiveHTML\`.\\n\\n').servable()

class MaterialTextField(MaterialBase):



    value = param.String(default='')



    _template = """

    <label id="text-field" class="mdc-text-field mdc-text-field--filled">

      <span class="mdc-text-field__ripple"></span>

      <span class="mdc-floating-label">Label</span>

      <input id="text-input" type="text" class="mdc-text-field__input" aria-labelledby="my-label" value="${value}"></input>

      <span class="mdc-line-ripple"></span>

    </label>

    """



    _dom_events = {'text-input': ['change']}



    _scripts = {

        'render': "mdc.textField.MDCTextField.attachTo(text_field);"

    }



class MaterialSlider(MaterialBase):



    end = param.Number(default=100)



    start = param.Number(default=0)



    value = param.Number(default=50)



    _template = """

    <div id="mdc-slider" class="mdc-slider" style="width: ${model.width}px">

      <input id="slider-input" class="mdc-slider__input" min="${start}" max="${end}" value="${value}">

      </input>

      <div class="mdc-slider__track">

        <div class="mdc-slider__track--inactive"></div>

        <div class="mdc-slider__track--active">

          <div class="mdc-slider__track--active_fill"></div>

        </div>

      </div>

      <div class="mdc-slider__thumb">

        <div class="mdc-slider__thumb-knob"></div>

      </div>

    </div>

    """



    _scripts = {

        'render': """

            slider_input.setAttribute('value', data.value)

            state.slider = mdc.slider.MDCSlider.attachTo(mdc_slider)

        """,

        'value': """

            state.slider.setValue(data.value)

        """

    }



slider     = MaterialSlider(value=5, start=0, end=100, width=200)

text_field = MaterialTextField()



pn.Row(

    pn.Column(

        slider.controls(['value']),

        slider

    ),

    pn.Column(

        text_field.controls(['value']),

        text_field

    ),

).servable()

pn.state.template.title = 'Wrapping Material UI components'

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