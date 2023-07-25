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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'numpy', 'pyvista']
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


import panel as pn
import numpy as np
import pyvista as pv

pn.extension('vtk', sizing_mode="stretch_width", template='fast')


# Temporal function inspired from http://holoviews.org/user_guide/Live_Data.html

# In[ ]:


alpha = 2
xvals  = np.linspace(-4, 4,101)
yvals  = np.linspace(-4, 4,101)
xs, ys = np.meshgrid(xvals, yvals)

#temporal function to create data on a plane
def time_function(time):
    return np.sin(((ys/alpha)**alpha+time)*xs)

# 3d plane to support the data
mesh_ref = pv.UniformGrid(
    dimensions=(xvals.size, yvals.size, 1), #dims
    spacing=(xvals[1]-xvals[0],yvals[1]-yvals[0],1), #spacing
    origin=(xvals.min(),yvals.min(),0) #origin
)
mesh_ref.point_data['values'] = time_function(0).flatten(order='F')  #add data for time=0
pl_ref = pv.Plotter()
pl_ref.add_mesh(mesh_ref, cmap='rainbow')

pn.pane.VTK(pl_ref.ren_win, min_height=600)


# We will demonstrate how to warp the surface and plot a temporal animation

# In[ ]:


mesh_warped = mesh_ref.warp_by_scalar() # warp the mesh using data at time=0
#create the pyvista plotter
pl = pv.Plotter()
pl.add_mesh(mesh_warped, cmap='rainbow')

#initialize panel and widgets
camera = {
    'position': [13.443258285522461, 12.239550590515137, 12.731934547424316],
    'focalPoint': [0, 0, 0],
     'viewUp': [-0.41067028045654297, -0.40083757042884827, 0.8189500570297241]
}
vtkpan = pn.pane.VTK(pl.ren_win, orientation_widget=True, sizing_mode='stretch_both', camera=camera)
frame = pn.widgets.Player(value=0, start=0, end=50, interval=100, loop_policy="reflect", height=100)

def update_3d_warp(event):
    #the player value range in between 0 and 50, however we want time between 0 and 10
    time = event.new/5
    data = time_function(time).flatten(order='F')
    mesh_ref.point_data['values'] = data
    mesh_warped.point_data['values'] = data
    mesh_warped.points = mesh_ref.warp_by_scalar(factor=0.5).points
    vtkpan.synchronize()
    
frame.param.watch(update_3d_warp, 'value')

pn.Column(
    "This app demonstrates the use of Panel to animate a \`VTK\` rendering.",
    frame,
    vtkpan,
    min_height=800
).servable(title='VTK Warp')



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