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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'numpy', 'pandas']
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


import json
import numpy as np
import pandas as pd
import panel as pn

pn.extension('deckgl', template='fast', sizing_mode="stretch_width")

pn.state.template.param.update(
    title="Deck.gl - Game of Life",
    main_max_width="768px"
)


# This demo was adapted from [PyDeck's Conway Game of Life example](https://github.com/uber/deck.gl/blob/66c75051d5b385db31f0a4322dff054779824783/bindings/pydeck/examples/06%20-%20Conway's%20Game%20of%20Life.ipynb), full copyright lies with the original authors.
# 
# This modified example demonstrates how to display and update a \`DeckGL\` pane with a periodic callback by modifying the JSON representation and triggering an update.

# ## Declare Game of Life logic

# In[ ]:


import random

def new_board(x, y, num_live_cells=2, num_dead_cells=3):
    """Initializes a board for Conway's Game of Life"""
    board = []
    for i in range(0, y):
        # Defaults to a 3:2 dead cell:live cell ratio
        board.append([random.choice([0] * num_dead_cells + [1] * num_live_cells) for _ in range(0, x)])
    return board

        
def get(board, x, y):
    """Return the value at location (x, y) on a board, wrapping around if out-of-bounds"""
    return board[y % len(board)][x % len(board[0])]


def assign(board, x, y, value):
    """Assigns a value at location (x, y) on a board, wrapping around if out-of-bounds"""
    board[y % len(board)][x % len(board[0])] = value


def count_neighbors(board, x, y):
    """Counts the number of living neighbors a cell at (x, y) on a board has"""
    return sum([
        get(board, x - 1, y),
        get(board, x + 1, y),
        get(board, x, y - 1),
        get(board, x, y + 1),
        get(board, x + 1, y + 1),
        get(board, x + 1, y - 1),
        get(board, x - 1, y + 1),
        get(board, x - 1, y - 1)])


def process_life(board):
    """Creates the next iteration from a passed state of Conway's Game of Life"""
    next_board = new_board(len(board[0]), len(board))
    for y in range(0, len(board)):
        for x in range(0, len(board[y])):
            num_neighbors = count_neighbors(board, x, y)
            is_alive = get(board, x, y) == 1
            if num_neighbors < 2 and is_alive:
                assign(next_board, x, y, 0)
            elif 2 <= num_neighbors <= 3 and is_alive:
                assign(next_board, x, y, 1)
            elif num_neighbors > 3 and is_alive:
                assign(next_board, x, y, 0)
            elif num_neighbors == 3 and not is_alive:
                assign(next_board, x, y, 1)
            else:
                assign(next_board, x, y, 0)
    return next_board


# ## Set up DeckGL JSON

# In[ ]:


points = {
    '@@type': 'PointCloudLayer',
    'data': [],
    'getColor': '@@=color',
    'getPosition': '@@=position',
    'getRadius': 40,
    'id': '0558257e-1a5c-43d7-bd98-1fba69981c6c'
}

board_json = {
    "initialViewState": {
        "bearing": 44,
        "latitude": 0.01,
        "longitude": 0.01,
        "pitch": 45,
        "zoom": 13
    },
    "layers": [points],
    "mapStyle": "",
    "views": [
        {
            "@@type": "MapView",
            "controller": True
        }
    ]
}


# ## Declare callbacks to periodically update the board

# In[ ]:


PINK = [155, 155, 255, 245]
PURPLE = [255, 155, 255, 245]

SCALING_FACTOR = 1000.0

def convert_board_to_df(board):
    """Makes the board matrix into a list for easier processing"""
    rows = []
    for x in range(0, len(board[0])):
        for y in range(0, len(board)):
            rows.append([[x / SCALING_FACTOR, y / SCALING_FACTOR], PURPLE if board[y][x] else PINK])
    return pd.DataFrame(rows, columns=['position', 'color'])

def run_gol(event=None):
    global board
    board = process_life(board)
    records = convert_board_to_df(board)
    points['data'] = records
    gol.param.trigger('object')
    
def reset_board(event):
    global board
    board = new_board(30, 30)
    run_gol()

def toggle_periodic_callback(event):
    if event.new:
        periodic_toggle.name = 'Stop'
        periodic_toggle.button_type = 'warning'
        periodic_cb.start()
    else:
        periodic_toggle.name = 'Run'
        periodic_toggle.button_type = 'primary'
        periodic_cb.stop()
        
def update_period(event):
    periodic_cb.period = event.new


# ## Set up Panel and callbacks

# In[ ]:


board = new_board(30, 30)

gol = pn.pane.DeckGL(board_json, height=400)

run_gol()

periodic_toggle = pn.widgets.Toggle(
    name='Run', value=False, button_type='primary', align='end', width=50
)
periodic_toggle.param.watch(toggle_periodic_callback, 'value')

period = pn.widgets.Spinner(name="Period (ms)", value=500, step=50, start=50,
                            align='end', width=100)
period.param.watch(update_period, 'value')

reset = pn.widgets.Button(name='Reset', button_type='warning', width=60, align='end')
reset.on_click(reset_board)

periodic_cb = pn.state.add_periodic_callback(run_gol, start=False, period=period.value)

settings = pn.Row(period, periodic_toggle, reset, width=400, sizing_mode="fixed")

description = """
**Conway's Game of Life** is a classic demonstration of *emergence*, where higher level patterns form from a few simple rules. Fantastic patterns emerge when the game is let to run long enough.

The **rules** here, to borrow from [Wikipedia](https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life), are as follows:

- Any live cell with fewer than two live neighbours dies, as if by underpopulation.
- Any live cell with two or three live neighbours lives on to the next generation.
- Any live cell with more than three live neighbours dies, as if by overpopulation.
- Any dead cell with exactly three live neighbours becomes a live cell, as if by reproduction.

This demo was **adapted from [PyDeck's Conway Game of Life example](https://github.com/uber/deck.gl/blob/66c75051d5b385db31f0a4322dff054779824783/bindings/pydeck/examples/06%20-%20Conway's%20Game%20of%20Life.ipynb)**, full copyright lies with the original authors.

This modified example demonstrates **how to display and update a \`DeckGL\` pane with a periodic callback** by modifying the JSON representation and triggering an update."""

pn.Column(
    '## Game of Life (using Deck.GL)',
    pn.Column(
        description,
        gol,
        settings
    ).servable()
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