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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'numpy']
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

import numpy as np

import panel as pn



pn.extension(template='bootstrap')

pn.pane.Markdown("\\nBokeh's property system defines the valid properties for all the different Bokeh models. Using \`\`jslink\`\` we can easily tie a widget value to Bokeh properties on another widget or plot. This example defines functions that generate a property editor for the most common Bokeh properties. First, we define two functions that generate a set of widgets linked to a plot:\\n\\n").servable()

from bokeh.core.enums import LineDash, LineCap, MarkerType, NamedColor

from bokeh.core.property.vectorization import Value

from bokeh.models.plots import Model, _list_attr_splat



def meta_widgets(model, width=500):

    tabs = pn.Tabs(width=width)

    widgets = get_widgets(model, width=width-25)

    if widgets:

        tabs.append((type(model).__name__, widgets))

    for p, v in model.properties_with_values().items():

        if isinstance(v, _list_attr_splat):

            v = v[0]

        if isinstance(v, Model):

            subtabs = meta_widgets(v)

            if subtabs is not None:

                tabs.append((p.title(), subtabs))



    if hasattr(model, 'renderers'):

        for r in model.renderers:

            tabs.append((type(r).__name__, meta_widgets(r)))

    if hasattr(model, 'axis') and isinstance(model.axis, list):

        for pre, axis in zip('XY', model.axis):

            tabs.append(('%s-Axis' % pre, meta_widgets(axis)))

    if hasattr(model, 'grid'):

        for pre, grid in zip('XY', model.grid):

            tabs.append(('%s-Grid' % pre, meta_widgets(grid)))

    if not widgets and not len(tabs) > 1:

        return None

    elif not len(tabs) > 1:

        return tabs[0]

    return tabs



def get_widgets(model, skip_none=True, **kwargs):

    widgets = []

    for p, v in model.properties_with_values().items():

        if isinstance(v, Value):

            v = v.value

        if v is None and skip_none:

            continue



        ps = dict(name=p, value=v, **kwargs)

        if 'alpha' in p:

            w = pn.widgets.FloatSlider(start=0, end=1, **ps)

        elif 'color' in p:

            if v in list(NamedColor):

                w = pn.widgets.Select(options=list(NamedColor), **ps)

            else:

                w = pn.widgets.ColorPicker(**ps)

        elif p=="width":

            w = pn.widgets.IntSlider(start=400, end=800, **ps)

        elif p in ["inner_width", "outer_width"]:

            w = pn.widgets.IntSlider(start=0, end=20, **ps)

        elif p.endswith('width'):

            w = pn.widgets.FloatSlider(start=0, end=20, **ps)

        elif 'marker' in p:

            w = pn.widgets.Select(options=list(MarkerType), **ps)

        elif p.endswith('cap'):

            w = pn.widgets.Select(options=list(LineCap), **ps)

        elif p == 'size':

            w = pn.widgets.FloatSlider(start=0, end=20, **ps)

        elif p.endswith('text') or p.endswith('label'):

            w = pn.widgets.TextInput(**ps)

        elif p.endswith('dash'):

            patterns = list(LineDash)

            w = pn.widgets.Select(options=patterns, value=v or patterns[0], **kwargs)

        else:

            continue

        w.jslink(model, value=p)

        widgets.append(w)

    return pn.Column(*sorted(widgets, key=lambda w: w.name))



# Having defined these helper functions we can now declare a plot and use the \`\`meta_widgets\`\` function to generate the GUI:



from bokeh.plotting import figure



p = figure(title='This is a title', x_axis_label='x-axis', y_axis_label='y-axis')

xs = np.linspace(0, 10)

r = p.scatter(xs, np.sin(xs))



editor=pn.Row(meta_widgets(p), p)



editor.servable()

pn.state.template.title = 'Bokeh property editor'

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