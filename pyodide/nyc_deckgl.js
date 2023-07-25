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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'fastparquet', 'pyodide-http']
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
import pandas as pd
import param

MAPBOX_KEY = "pk.eyJ1IjoicGFuZWxvcmciLCJhIjoiY2s1enA3ejhyMWhmZjNobjM1NXhtbWRrMyJ9.B_frQsAVepGIe-HiOJeqvQ"

pn.extension('deckgl', design='bootstrap', theme='dark', template='bootstrap')

pn.state.template.config.raw_css.append("""
#main {
  padding: 0;
}""")


# ## Define App

# In[ ]:


class App(pn.viewable.Viewer):

    data = param.DataFrame(precedence=-1)

    view = param.DataFrame(precedence=-1)

    arc_view = param.DataFrame(precedence=-1)

    radius = param.Integer(default=50, bounds=(20, 1000))

    elevation = param.Integer(default=10, bounds=(0, 50))

    hour = param.Integer(default=0, bounds=(0, 23))

    speed = param.Integer(default=1, bounds=(0, 10), precedence=-1)

    play = param.Event(label='▷')

    def __init__(self, **params):
        self.deck_gl = None
        super().__init__(**params)
        self._update_arc_view()
        self.deck_gl = pn.pane.DeckGL(
            self.spec,
            mapbox_api_key=MAPBOX_KEY,
            throttle={'click': 10},
            sizing_mode='stretch_both',
            margin=0
        )
        self.deck_gl.param.watch(self._update_arc_view, 'click_state')
        self._playing = False
        self._cb = pn.state.add_periodic_callback(
            self._update_hour, 1000//self.speed, start=False
        )

    @param.depends('view', 'radius', 'elevation', 'arc_view')
    def spec(self):
        return {
            "initialViewState": {
                "bearing": 0,
                "latitude": 40.7,
                "longitude": -73.9,
                "maxZoom": 15,
                "minZoom": 5,
                "pitch": 40.5,
                "zoom": 11
            },
            "layers": [self.hex_layer, self.arc_layer],
            "mapStyle": "mapbox://styles/mapbox/dark-v9",
            "views": [
                {"@@type": "MapView", "controller": True}
            ]
        }

    @property
    def hex_layer(self):
        return {
            "@@type": "HexagonLayer",
            "autoHighlight": True,
            "coverage": 1,
            "data": self.data if self.view is None else self.view,
            "elevationRange": [0, 100],
            "elevationScale": self.elevation,
            "radius": self.radius,
            "extruded": True,
            "getPosition": "@@=[pickup_x, pickup_y]",
            "id": "8a553b25-ef3a-489c-bbe2-e102d18a3211"
        }

    @property
    def arc_layer(self):
        return {
            "@@type": "ArcLayer",
            "id": 'arc-layer',
            "data": self.arc_view,
            "pickable": True,
            "getWidth": 2,
            "getSourcePosition": "@@=[pickup_x, pickup_y]",
            "getTargetPosition": "@@=[dropoff_x, dropoff_y]",
            "getSourceColor": [0, 255, 0, 180],
            "getTargetColor": [240, 100, 0, 180]
        }

    def _update_hour(self):
        self.hour = (self.hour+1) % 24

    @param.depends('hour', watch=True, on_init=True)
    def _update_hourly_view(self):
        self.view = self.data[self.data.hour==self.hour]

    @param.depends('view', 'radius', watch=True)
    def _update_arc_view(self, event=None):
        data = self.data if self.view is None else self.view
        lon, lat, = (-73.9857, 40.7484)
        if self.deck_gl:
            lon, lat = self.deck_gl.click_state.get('coordinate', (lon, lat))
        tol = self.radius / 100000
        self.arc_view = data[
            (data.pickup_x>=float(lon-tol)) &
            (data.pickup_x<=float(lon+tol)) &
            (data.pickup_y>=float(lat-tol)) &
            (data.pickup_y<=float(lat+tol))
        ]

    @param.depends('speed', watch=True)
    def _update_speed(self):
        self._cb.period = 1000//self.speed

    @param.depends('play', watch=True)
    def _play_pause(self):
        if self._playing:
            self._cb.stop()
            self.param.play.label = '▷'
            self.param.speed.precedence = -1
        else:
            self._cb.start()
            self.param.play.label = '❚❚'
            self.param.speed.precedence = 1
        self._playing = not self._playing

    @property
    def controls(self):
        return pn.Param(app.param, show_name=False)

    def __panel__(self):
        return pn.Row(
            self.controls,
            self.deck_gl,
            min_height=800,
            sizing_mode='stretch_both',
        )


# ## Display app

# In[ ]:


df = pd.read_parquet('https://datasets.holoviz.org/nyc_taxi_small/v1/nyc_taxi_small.parq')

app = App(data=df)

app.controls.servable(area='sidebar')
app.deck_gl.servable(title='NYC Taxi Deck.GL Explorer')

app



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