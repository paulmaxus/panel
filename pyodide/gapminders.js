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
  const env_spec = ['https://cdn.holoviz.org/panel/1.2.1/dist/wheels/bokeh-3.2.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.2.1/dist/wheels/panel-1.2.1-py3-none-any.whl', 'pyodide-http==0.2.1', 'altair', 'plotly', 'hvplot']
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


import param
import numpy as np 
import pandas as pd
import panel as pn

import altair as alt
import plotly.graph_objs as go
import plotly.io as pio
import matplotlib.pyplot as plt

pn.extension('vega', 'plotly', defer_load=True, template='fast')
import hvplot.pandas


# ## Configuration
# 
# Let us start by configuring some high-level variables and configure the template:

# In[ ]:


XLABEL = 'GDP per capita (2000 dollars)'
YLABEL = 'Life expectancy (years)'
YLIM = (20, 90)
ACCENT = "#00A170"

PERIOD = 1000 # milliseconds

pn.state.template.param.update(
    site_url="https://panel.holoviz.org",
    title="Hans Rosling's Gapminder",
    header_background=ACCENT,
    accent_base_color=ACCENT,
    favicon="static/extensions/panel/images/favicon.ico",
    theme_toggle=False
)


# ## Extract the dataset
# 
# First, we'll get the data into a Pandas dataframe. We use the [built in \`cache\`](https://panel.holoviz.org/how_to/caching/memoization.html) to speed up the app.

# In[ ]:


@pn.cache
def get_dataset():
    url = 'https://raw.githubusercontent.com/plotly/datasets/master/gapminderDataFiveYear.csv'
    return pd.read_csv(url)

dataset = get_dataset()

YEARS = [int(year) for year in dataset.year.unique()]

dataset.sample(10)


# ## Set up widgets and description
# 
# Next we will set up a periodic callback to allow cycling through the years, set up the widgets to control the application and write an introduction:

# In[ ]:


def play():
    if year.value == YEARS[-1]:
        year.value = YEARS[0]
        return

    index = YEARS.index(year.value)
    year.value = YEARS[index+1]    

year = pn.widgets.DiscreteSlider(
    value=YEARS[-1], options=YEARS, name="Year", width=280
)
show_legend = pn.widgets.Checkbox(value=True, name="Show Legend")

periodic_callback = pn.state.add_periodic_callback(play, start=False, period=PERIOD)
player = pn.widgets.Checkbox.from_param(periodic_callback.param.running, name="Autoplay")

widgets = pn.Column(year, player, show_legend, margin=(0,15))

desc = """## 🎓 Info

The [Panel](http://panel.holoviz.org) library from [HoloViz](http://holoviz.org)
lets you make widget-controlled apps and dashboards from a wide variety of 
plotting libraries and data types. Here you can try out four different plotting libraries
controlled by a couple of widgets, for Hans Rosling's 
[gapminder](https://demo.bokeh.org/gapminder) example.

Source: [pyviz-topics - gapminder](https://github.com/pyviz-topics/examples/blob/master/gapminders/gapminders.ipynb)
"""

settings = pn.Column(
    "## ⚙️ Settings", widgets, desc,
    sizing_mode='stretch_width'
).servable(area='sidebar')

settings


# ## Define plotting functions
# 
# Now let's define helper functions and functions to plot this dataset with Matplotlib, Plotly, Altair, and hvPlot (using HoloViews and Bokeh).

# In[ ]:


@pn.cache
def get_data(year):
    df = dataset[(dataset.year==year) & (dataset.gdpPercap < 10000)].copy()
    df['size'] = np.sqrt(df['pop']*2.666051223553066e-05)
    df['size_hvplot'] = df['size']*6
    return df

def get_title(library, year):
    return f"{library}: Life expectancy vs. GDP, {year}"

def get_xlim(data):
    return (data['gdpPercap'].min()-100,data['gdpPercap'].max()+1000)

@pn.cache
def mpl_view(year=1952, show_legend=True):
    data = get_data(year)
    title = get_title("Matplotlib", year)
    xlim = get_xlim(data)

    plot = plt.figure(figsize=(10, 6), facecolor=(0, 0, 0, 0))
    ax = plot.add_subplot(111)
    ax.set_xscale("log")
    ax.set_title(title)
    ax.set_xlabel(XLABEL)
    ax.set_ylabel(YLABEL)
    ax.set_ylim(YLIM)
    ax.set_xlim(xlim)

    for continent, df in data.groupby('continent'):
        ax.scatter(df.gdpPercap, y=df.lifeExp, s=df['size']*5,
                   edgecolor='black', label=continent)

    if show_legend:
        ax.legend(loc=4)

    plt.close(plot)
    return plot

pio.templates.default = None

@pn.cache
def plotly_view(year=1952, show_legend=True):
    data = get_data(year)
    title = get_title("Plotly", year)
    xlim = get_xlim(data)

    traces = []
    for continent, df in data.groupby('continent'):
        marker=dict(symbol='circle', sizemode='area', sizeref=0.1, size=df['size'], line=dict(width=2))
        traces.append(go.Scatter(x=df.gdpPercap, y=df.lifeExp, mode='markers', marker=marker, name=continent, text=df.country))

    axis_opts = dict(gridcolor='rgb(255, 255, 255)', zerolinewidth=1, ticklen=5, gridwidth=2)
    layout = go.Layout(
        title=title, showlegend=show_legend,
        xaxis=dict(title=XLABEL, type='log', **axis_opts),
        yaxis=dict(title=YLABEL, **axis_opts),
        autosize=True, paper_bgcolor='rgba(0,0,0,0)',
    )
    
    return go.Figure(data=traces, layout=layout)

@pn.cache
def altair_view(year=1952, show_legend=True, height="container", width="container"):
    data = get_data(year)
    title = get_title("Altair/ Vega", year)
    xlim = get_xlim(data)
    legend= ({} if show_legend else {'legend': None})
    return (
        alt.Chart(data)
            .mark_circle().encode(
                alt.X('gdpPercap:Q', scale=alt.Scale(type='log'), axis=alt.Axis(title=XLABEL)),
                alt.Y('lifeExp:Q', scale=alt.Scale(zero=False, domain=YLIM), axis=alt.Axis(title=YLABEL)),
                size=alt.Size('pop:Q', scale=alt.Scale(type="log"), legend=None),
                color=alt.Color('continent', scale=alt.Scale(scheme="category10"), **legend),
                tooltip=['continent','country'])
            .configure_axis(grid=False)
            .properties(title=title, height=height, width=width, background='rgba(0,0,0,0)') 
            .configure_view(fill="white")
            .interactive()
    )

@pn.cache
def hvplot_view(year=1952, show_legend=True):
    data = get_data(year)
    title = get_title("hvPlot/ Bokeh", year)
    xlim = get_xlim(data)
    return data.hvplot.scatter(
        'gdpPercap', 'lifeExp', by='continent', s='size_hvplot', alpha=0.8,
        logx=True, title=title, responsive=True, legend='bottom_right',
        hover_cols=['country'], ylim=YLIM, xlim=xlim, ylabel=YLABEL, xlabel=XLABEL
    )


# ## Bind the plot functions to the widgets

# In[ ]:


mpl_view    = pn.bind(mpl_view,    year=year, show_legend=show_legend)
plotly_view = pn.bind(plotly_view, year=year, show_legend=show_legend)
altair_view = pn.bind(altair_view, year=year, show_legend=show_legend)
hvplot_view = pn.bind(hvplot_view, year=year, show_legend=show_legend)

plots = pn.layout.GridBox(
    pn.pane.Matplotlib(mpl_view, format='png', sizing_mode='scale_both', tight=True, margin=10),
    pn.pane.HoloViews(hvplot_view, sizing_mode='stretch_both', margin=10),
    pn.pane.Plotly(plotly_view, sizing_mode='stretch_both', margin=10),
    pn.pane.Vega(altair_view, sizing_mode='stretch_both', margin=10),
    ncols=2,
    sizing_mode="stretch_both"
).servable()

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