<template>
  <div class="terminal-shell">
    <header class="terminal-header">
      <div class="terminal-brand">
        <span class="brand-mark">MIROFISH</span>
        <span class="brand-sub">operator + graph terminal</span>
      </div>

      <div class="terminal-tabs">
        <button
          class="terminal-tab"
          :class="{ active: activeTab === 'operator' }"
          @click="setTab('operator')"
        >
          Operator
        </button>
        <button
          class="terminal-tab"
          :class="{ active: activeTab === 'graph' }"
          @click="setTab('graph')"
        >
          MiroFish Graph
        </button>
      </div>
    </header>

    <main class="terminal-main">
      <iframe
        v-if="activeTab === 'operator'"
        :src="terminalUrl"
        class="terminal-frame"
        title="MiroShark Terminal"
        allow="clipboard-write"
      />

      <div v-else class="graph-shell">
        <aside class="graph-sidebar">
          <div class="sidebar-card">
            <div class="card-title">Graph Source</div>
            <div class="source-toggle">
              <button
                v-for="mode in sourceModes"
                :key="mode.value"
                class="source-btn"
                :class="{ active: sourceMode === mode.value }"
                @click="sourceMode = mode.value"
              >
                {{ mode.label }}
              </button>
            </div>

            <label v-if="sourceMode !== 'demo'" class="field-label" :for="`source-${sourceMode}`">
              {{ sourceLabel }}
            </label>
            <input
              v-if="sourceMode !== 'demo'"
              :id="`source-${sourceMode}`"
              v-model.trim="sourceValue"
              class="source-input"
              :placeholder="sourcePlaceholder"
              @keyup.enter="loadGraphContext"
            />

            <div class="card-actions">
              <button class="load-btn" @click="loadGraphContext" :disabled="graphLoading || (sourceMode !== 'demo' && !sourceValue)">
                {{ graphLoading ? 'Loading…' : sourceMode === 'demo' ? 'Load Demo Swarm' : 'Load Graph' }}
              </button>
            </div>

            <p class="card-help">
              <span v-if="sourceMode === 'demo'">
                Loads a local swarm-topology fixture so the MiroFish graph UI is visible even before upstream graphs exist.
              </span>
              <span v-else>
                Use a `graphId`, `projectId`, or `simulationId`. Real graph data is loaded from the upstream MiroFish backend on `:5001`.
              </span>
            </p>
          </div>

          <div class="sidebar-card">
            <div class="card-title">Resolved Context</div>
            <dl class="context-list">
              <div class="context-row">
                <dt>Graph</dt>
                <dd>{{ resolvedGraphId || '—' }}</dd>
              </div>
              <div class="context-row">
                <dt>Project</dt>
                <dd>{{ resolvedProjectId || '—' }}</dd>
              </div>
              <div class="context-row">
                <dt>Simulation</dt>
                <dd>{{ resolvedSimulationId || '—' }}</dd>
              </div>
            </dl>
            <p v-if="graphError" class="graph-error">{{ graphError }}</p>
            <p v-else class="graph-status">{{ graphStatus }}</p>
          </div>
        </aside>

        <section class="graph-stage">
          <GraphPanel
            :graphData="graphData"
            :loading="graphLoading"
            :currentPhase="3"
            :isSimulating="false"
            @refresh="refreshGraph"
          />
        </section>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import GraphPanel from '../components/GraphPanel.vue'
import { getProject, getGraphData } from '../api/graph'
import { demoGraphData } from '../fixtures/demoGraph'
import { getSimulation } from '../api/simulation'

const route = useRoute()
const router = useRouter()

const sourceModes = [
  { value: 'demo', label: 'Demo Swarm' },
  { value: 'graph', label: 'Graph' },
  { value: 'project', label: 'Project' },
  { value: 'simulation', label: 'Simulation' }
]

const activeTab = ref(route.query.tab === 'graph' ? 'graph' : 'operator')
const sourceMode = ref(route.query.source || inferSourceMode(route.query))
const sourceValue = ref(initialSourceValue(route.query))

const graphData = ref(null)
const graphLoading = ref(false)
const graphError = ref('')
const resolvedGraphId = ref('')
const resolvedProjectId = ref('')
const resolvedSimulationId = ref('')

const terminalUrl = computed(() => {
  const env = import.meta.env.VITE_EXECUTION_ROUTER_URL
  if (env) return env
  const host = window.location.hostname || 'localhost'
  return `http://${host}:5004/`
})

const sourceLabel = computed(() => {
  if (sourceMode.value === 'demo') return 'Demo Mode'
  if (sourceMode.value === 'project') return 'Project ID'
  if (sourceMode.value === 'simulation') return 'Simulation ID'
  return 'Graph ID'
})

const sourcePlaceholder = computed(() => {
  if (sourceMode.value === 'demo') return ''
  if (sourceMode.value === 'project') return 'proj_… or project uuid'
  if (sourceMode.value === 'simulation') return 'simulation id'
  return 'mirofish_… graph id'
})

const graphStatus = computed(() => {
  if (graphLoading.value) return 'Loading graph data…'
  if (resolvedGraphId.value === 'demo-swarm-topology') {
    const nodeCount = graphData.value?.nodes?.length || 0
    const edgeCount = graphData.value?.edges?.length || 0
    return `Demo swarm topology · ${nodeCount} nodes · ${edgeCount} edges`
  }
  if (!graphData.value) return 'No graph loaded.'
  const nodeCount = graphData.value.nodes?.length || 0
  const edgeCount = graphData.value.edges?.length || 0
  return `${nodeCount} nodes · ${edgeCount} edges`
})

function inferSourceMode(query) {
  if (query.source === 'demo') return 'demo'
  if (query.simulationId) return 'simulation'
  if (query.projectId) return 'project'
  if (query.graphId) return 'graph'
  return 'demo'
}

function initialSourceValue(query) {
  return query.graphId || query.projectId || query.simulationId || ''
}

function setTab(tab) {
  activeTab.value = tab
  syncRouteQuery()
  if (tab === 'graph' && !graphData.value) {
    loadGraphContext()
  }
}

function syncRouteQuery() {
  const query = { ...route.query, tab: activeTab.value, source: sourceMode.value }

  delete query.graphId
  delete query.projectId
  delete query.simulationId

  if (sourceMode.value === 'demo') {
    delete query.graphId
    delete query.projectId
    delete query.simulationId
  } else if (sourceValue.value) {
    if (sourceMode.value === 'simulation') query.simulationId = sourceValue.value
    else if (sourceMode.value === 'project') query.projectId = sourceValue.value
    else query.graphId = sourceValue.value
  }

  router.replace({ query })
}

function clearResolvedContext() {
  graphError.value = ''
  resolvedGraphId.value = ''
  resolvedProjectId.value = ''
  resolvedSimulationId.value = ''
}

async function resolveGraphId() {
  const raw = sourceValue.value
  if (sourceMode.value === 'demo') {
    resolvedGraphId.value = 'demo-swarm-topology'
    resolvedProjectId.value = 'demo-project'
    resolvedSimulationId.value = 'demo-simulation'
    return resolvedGraphId.value
  }

  if (!raw) throw new Error('Enter an identifier first.')

  if (sourceMode.value === 'graph') {
    resolvedGraphId.value = raw
    return raw
  }

  if (sourceMode.value === 'project') {
    resolvedProjectId.value = raw
    const project = await getProject(raw)
    const graphId = project?.data?.graph_id
    if (!graphId) throw new Error('This project has no graph_id.')
    resolvedGraphId.value = graphId
    return graphId
  }

  resolvedSimulationId.value = raw
  const simulation = await getSimulation(raw)
  const sim = simulation?.data
  if (!sim) throw new Error('Simulation not found.')

  if (sim.graph_id) {
    resolvedGraphId.value = sim.graph_id
  } else if (sim.project_id) {
    resolvedProjectId.value = sim.project_id
    const project = await getProject(sim.project_id)
    const graphId = project?.data?.graph_id
    if (!graphId) throw new Error('This simulation resolved to a project without graph_id.')
    resolvedGraphId.value = graphId
  } else {
    throw new Error('Simulation has no graph_id or project_id.')
  }

  if (!resolvedProjectId.value && sim.project_id) {
    resolvedProjectId.value = sim.project_id
  }
  return resolvedGraphId.value
}

async function loadGraphContext() {
  if (sourceMode.value !== 'demo' && !sourceValue.value) return

  activeTab.value = 'graph'
  graphLoading.value = true
  graphError.value = ''
  clearResolvedContext()
  syncRouteQuery()

  try {
    const graphId = await resolveGraphId()
    if (sourceMode.value === 'demo') {
      graphData.value = demoGraphData
    } else {
      const res = await getGraphData(graphId)
      if (!res?.data) throw new Error('Graph data response was empty.')
      graphData.value = res.data
    }
  } catch (error) {
    graphData.value = null
    graphError.value = error?.message || 'Failed to load graph.'
  } finally {
    graphLoading.value = false
  }
}

async function refreshGraph() {
  if (sourceMode.value === 'demo') {
    graphData.value = demoGraphData
    graphError.value = ''
    resolvedGraphId.value = 'demo-swarm-topology'
    resolvedProjectId.value = 'demo-project'
    resolvedSimulationId.value = 'demo-simulation'
    return
  }

  if (!resolvedGraphId.value) {
    await loadGraphContext()
    return
  }

  graphLoading.value = true
  graphError.value = ''
  try {
    const res = await getGraphData(resolvedGraphId.value)
    if (!res?.data) throw new Error('Graph data response was empty.')
    graphData.value = res.data
  } catch (error) {
    graphError.value = error?.message || 'Failed to refresh graph.'
  } finally {
    graphLoading.value = false
  }
}

onMounted(async () => {
  if (activeTab.value === 'graph' && (sourceMode.value === 'demo' || sourceValue.value)) {
    await loadGraphContext()
  }
})

watch(sourceMode, async (mode) => {
  if (mode === 'demo') {
    sourceValue.value = ''
  }
  syncRouteQuery()
  if (activeTab.value === 'graph' && mode === 'demo') {
    await loadGraphContext()
  }
})
</script>

<style scoped>
.terminal-shell {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #f4f7fb 0%, #eef2f7 100%);
  color: #0f172a;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid #d7dde7;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(10px);
}

.terminal-brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand-mark {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.18em;
  color: #111827;
}

.brand-sub {
  font-size: 12px;
  color: #64748b;
}

.terminal-tabs {
  display: flex;
  gap: 8px;
}

.terminal-tab {
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #334155;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.terminal-tab.active {
  background: #111827;
  color: #ffffff;
  border-color: #111827;
}

.terminal-main {
  flex: 1;
  min-height: 0;
}

.terminal-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.graph-shell {
  height: 100%;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
}

.graph-sidebar {
  border-right: 1px solid #d7dde7;
  background: rgba(255, 255, 255, 0.88);
  padding: 18px;
  overflow: auto;
}

.sidebar-card {
  background: #ffffff;
  border: 1px solid #dde4ee;
  border-radius: 18px;
  padding: 16px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
}

.sidebar-card + .sidebar-card {
  margin-top: 14px;
}

.card-title {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #475569;
  margin-bottom: 12px;
}

.source-toggle {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.source-btn {
  border: 1px solid #d4dce7;
  background: #f8fafc;
  color: #334155;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.source-btn.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.field-label {
  display: block;
  font-size: 12px;
  color: #475569;
  margin-bottom: 8px;
}

.source-input {
  width: 100%;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  color: #0f172a;
}

.card-actions {
  margin-top: 12px;
}

.load-btn {
  width: 100%;
  border: 0;
  background: #0f172a;
  color: #fff;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.load-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.card-help {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #64748b;
}

.context-list {
  margin: 0;
}

.context-row {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 10px;
  font-size: 12px;
  padding: 7px 0;
  border-bottom: 1px solid #eef2f7;
}

.context-row:last-child {
  border-bottom: 0;
}

.context-row dt {
  color: #64748b;
}

.context-row dd {
  margin: 0;
  word-break: break-word;
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.graph-status,
.graph-error {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
}

.graph-status {
  color: #475569;
}

.graph-error {
  color: #b91c1c;
}

.graph-stage {
  min-width: 0;
  min-height: 0;
}

@media (max-width: 980px) {
  .graph-shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .graph-sidebar {
    border-right: 0;
    border-bottom: 1px solid #d7dde7;
  }
}
</style>
