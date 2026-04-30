'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'

const PALETTE = ['#FF6B35', '#004E89', '#7B2D8E', '#1A936F', '#C5283D', '#E9724C', '#3498db', '#9b59b6', '#27ae60', '#f39c12']

function buildSelectionSummary(selectedNodes, selectedEdges) {
  const typeMap = new Map()
  const adjacency = new Map()
  const nodeById = new Map(selectedNodes.map((item) => [item.id, item]))

  selectedNodes.forEach((node) => {
    typeMap.set(node.type, (typeMap.get(node.type) || 0) + 1)
    adjacency.set(node.id, new Set())
  })

  selectedEdges.forEach((edge) => {
    if (adjacency.has(edge.source.id) && adjacency.has(edge.target.id)) {
      adjacency.get(edge.source.id).add(edge.target.id)
      adjacency.get(edge.target.id).add(edge.source.id)
    }
  })

  const visited = new Set()
  const components = []

  selectedNodes.forEach((node) => {
    if (visited.has(node.id)) return
    const queue = [node.id]
    const ids = []
    visited.add(node.id)

    while (queue.length) {
      const current = queue.shift()
      ids.push(current)
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }

    const edgeCount = selectedEdges.filter(
      (edge) => ids.includes(edge.source.id) && ids.includes(edge.target.id),
    ).length

    components.push({
      nodeCount: ids.length,
      edgeCount,
      nodes: ids.map((id) => {
        const item = nodeById.get(id)
        return { id: item.id, name: item.name }
      }),
    })
  })

  return {
    nodeCount: selectedNodes.length,
    edgeCount: selectedEdges.length,
    componentCount: components.length,
    components,
    types: Array.from(typeMap.entries()).map(([name, count]) => ({ name, count })),
  }
}

function formatDateTime(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return value
  }
}

export default function GraphPanel({
  graphData,
  loading = false,
  isSimulating = false,
  currentPhase = 0,
  onRefresh,
}) {
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const simulationRef = useRef(null)
  const nodeRef = useRef(null)
  const linkRef = useRef(null)
  const linkLabelsRef = useRef(null)
  const linkLabelBgRef = useRef(null)
  const transformRef = useRef(d3.zoomIdentity)
  const resizeObserverRef = useRef(null)
  const resizeFrameRef = useRef(null)

  const [selectedItem, setSelectedItem] = useState(null)
  const [showEdgeLabels, setShowEdgeLabels] = useState(true)
  const [rectSelectMode, setRectSelectMode] = useState(false)
  const [showSimulationFinishedHint, setShowSimulationFinishedHint] = useState(false)
  const wasSimulatingRef = useRef(false)

  const entityTypes = useMemo(() => {
    if (!graphData?.nodes) return []
    const typeMap = {}
    graphData.nodes.forEach((node) => {
      const type = node.labels?.find((label) => label !== 'Entity') || 'Entity'
      if (!typeMap[type]) {
        typeMap[type] = { name: type, count: 0, color: PALETTE[Object.keys(typeMap).length % PALETTE.length] }
      }
      typeMap[type].count += 1
    })
    return Object.values(typeMap)
  }, [graphData])

  useEffect(() => {
    if (wasSimulatingRef.current && !isSimulating) {
      setShowSimulationFinishedHint(true)
    }
    wasSimulatingRef.current = isSimulating
  }, [isSimulating])

  useEffect(() => {
    if (linkLabelsRef.current) {
      linkLabelsRef.current.style('display', showEdgeLabels ? 'block' : 'none')
    }
    if (linkLabelBgRef.current) {
      linkLabelBgRef.current.style('display', showEdgeLabels ? 'block' : 'none')
    }
  }, [showEdgeLabels])

  const clearGraphSelection = () => {
    setSelectedItem(null)
    if (nodeRef.current) {
      nodeRef.current.attr('stroke', '#fff').attr('stroke-width', 2.5)
    }
    if (linkRef.current) {
      linkRef.current.attr('stroke', '#C0C0C0').attr('stroke-width', 1.5)
    }
    if (linkLabelsRef.current) {
      linkLabelsRef.current.attr('fill', '#666')
    }
    if (linkLabelBgRef.current) {
      linkLabelBgRef.current.attr('fill', 'rgba(255,255,255,0.95)')
    }
  }

  const scheduleRender = () => {
    if (resizeFrameRef.current) {
      cancelAnimationFrame(resizeFrameRef.current)
    }
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null
      renderGraph()
    })
  }

  const renderGraph = () => {
    if (!svgRef.current || !graphData || !containerRef.current) return

    if (simulationRef.current) {
      simulationRef.current.stop()
    }

    const rect = containerRef.current.getBoundingClientRect()
    const width = Math.max(containerRef.current.clientWidth || 0, Math.round(rect.width || 0))
    const height = Math.max(containerRef.current.clientHeight || 0, Math.round(rect.height || 0))
    if (width < 40 || height < 40) return

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)

    svg.selectAll('*').remove()

    const nodesData = graphData.nodes || []
    const edgesData = graphData.edges || []
    if (!nodesData.length) return

    const nodeMap = {}
    nodesData.forEach((node) => { nodeMap[node.uuid] = node })

    const colorMap = {}
    entityTypes.forEach((type) => { colorMap[type.name] = type.color })
    const getColor = (type) => colorMap[type] || '#999'

    const nodes = nodesData.map((node) => ({
      id: node.uuid,
      name: node.name || 'Unnamed',
      type: node.labels?.find((label) => label !== 'Entity') || 'Entity',
      rawData: node,
    }))

    const nodeIds = new Set(nodes.map((node) => node.id))
    const edgePairCount = {}
    const selfLoopEdges = {}
    const tempEdges = edgesData.filter(
      (edge) => nodeIds.has(edge.source_node_uuid) && nodeIds.has(edge.target_node_uuid),
    )

    tempEdges.forEach((edge) => {
      if (edge.source_node_uuid === edge.target_node_uuid) {
        if (!selfLoopEdges[edge.source_node_uuid]) {
          selfLoopEdges[edge.source_node_uuid] = []
        }
        selfLoopEdges[edge.source_node_uuid].push({
          ...edge,
          source_name: nodeMap[edge.source_node_uuid]?.name,
          target_name: nodeMap[edge.target_node_uuid]?.name,
        })
      } else {
        const pairKey = [edge.source_node_uuid, edge.target_node_uuid].sort().join('_')
        edgePairCount[pairKey] = (edgePairCount[pairKey] || 0) + 1
      }
    })

    const edgePairIndex = {}
    const processedSelfLoopNodes = new Set()
    const edges = []

    tempEdges.forEach((edge) => {
      const isSelfLoop = edge.source_node_uuid === edge.target_node_uuid
      if (isSelfLoop) {
        if (processedSelfLoopNodes.has(edge.source_node_uuid)) return
        processedSelfLoopNodes.add(edge.source_node_uuid)
        const allSelfLoops = selfLoopEdges[edge.source_node_uuid]
        const nodeName = nodeMap[edge.source_node_uuid]?.name || 'Unknown'
        edges.push({
          source: edge.source_node_uuid,
          target: edge.target_node_uuid,
          type: 'SELF_LOOP',
          name: `Self Relations (${allSelfLoops.length})`,
          curvature: 0,
          isSelfLoop: true,
          rawData: {
            isSelfLoopGroup: true,
            source_name: nodeName,
            target_name: nodeName,
            selfLoopCount: allSelfLoops.length,
            selfLoopEdges: allSelfLoops,
          },
        })
        return
      }

      const pairKey = [edge.source_node_uuid, edge.target_node_uuid].sort().join('_')
      const totalCount = edgePairCount[pairKey]
      const currentIndex = edgePairIndex[pairKey] || 0
      edgePairIndex[pairKey] = currentIndex + 1

      const isReversed = edge.source_node_uuid > edge.target_node_uuid
      let curvature = 0
      if (totalCount > 1) {
        const curvatureRange = Math.min(1.2, 0.6 + totalCount * 0.15)
        curvature = ((currentIndex / (totalCount - 1)) - 0.5) * curvatureRange * 2
        if (isReversed) curvature = -curvature
      }

      edges.push({
        source: edge.source_node_uuid,
        target: edge.target_node_uuid,
        type: edge.fact_type || edge.name || 'RELATED',
        name: edge.name || edge.fact_type || 'RELATED',
        curvature,
        isSelfLoop: false,
        pairIndex: currentIndex,
        pairTotal: totalCount,
        rawData: {
          ...edge,
          source_name: nodeMap[edge.source_node_uuid]?.name,
          target_name: nodeMap[edge.target_node_uuid]?.name,
        },
      })
    })

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id((d) => d.id).distance((d) => {
        const baseDistance = 150
        const edgeCount = d.pairTotal || 1
        return baseDistance + (edgeCount - 1) * 50
      }))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(50))
      .force('x', d3.forceX(width / 2).strength(0.04))
      .force('y', d3.forceY(height / 2).strength(0.04))

    simulationRef.current = simulation

    const getLinkPath = (edge) => {
      const sx = edge.source.x
      const sy = edge.source.y
      const tx = edge.target.x
      const ty = edge.target.y

      if (edge.isSelfLoop) {
        const loopRadius = 30
        return `M${sx + 8},${sy - 4} A${loopRadius},${loopRadius} 0 1,1 ${sx + 8},${sy + 4}`
      }

      if (edge.curvature === 0) return `M${sx},${sy} L${tx},${ty}`

      const dx = tx - sx
      const dy = ty - sy
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const pairTotal = edge.pairTotal || 1
      const offsetRatio = 0.25 + pairTotal * 0.05
      const baseOffset = Math.max(35, dist * offsetRatio)
      const offsetX = (-dy / dist) * edge.curvature * baseOffset
      const offsetY = (dx / dist) * edge.curvature * baseOffset
      const cx = (sx + tx) / 2 + offsetX
      const cy = (sy + ty) / 2 + offsetY
      return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`
    }

    const getLinkMidpoint = (edge) => {
      const sx = edge.source.x
      const sy = edge.source.y
      const tx = edge.target.x
      const ty = edge.target.y

      if (edge.isSelfLoop) return { x: sx + 70, y: sy }
      if (edge.curvature === 0) return { x: (sx + tx) / 2, y: (sy + ty) / 2 }

      const dx = tx - sx
      const dy = ty - sy
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const pairTotal = edge.pairTotal || 1
      const offsetRatio = 0.25 + pairTotal * 0.05
      const baseOffset = Math.max(35, dist * offsetRatio)
      const offsetX = (-dy / dist) * edge.curvature * baseOffset
      const offsetY = (dx / dist) * edge.curvature * baseOffset
      const cx = (sx + tx) / 2 + offsetX
      const cy = (sy + ty) / 2 + offsetY

      return {
        x: (0.25 * sx) + (0.5 * cx) + (0.25 * tx),
        y: (0.25 * sy) + (0.5 * cy) + (0.25 * ty),
      }
    }

    const g = svg.append('g')
    svg.call(
      d3.zoom().extent([[0, 0], [width, height]]).scaleExtent([0.1, 4]).on('zoom', (event) => {
        transformRef.current = event.transform
        g.attr('transform', event.transform)
      }),
    )

    const linkGroup = g.append('g').attr('class', 'links')
    const link = linkGroup.selectAll('path')
      .data(edges)
      .enter()
      .append('path')
      .attr('stroke', '#C0C0C0')
      .attr('stroke-width', 1.5)
      .attr('fill', 'none')
      .style('cursor', 'pointer')
      .on('click', (event, edge) => {
        event.stopPropagation()
        clearGraphSelection()
        d3.select(event.target).attr('stroke', '#3498db').attr('stroke-width', 3)
        setSelectedItem({ type: 'edge', data: edge.rawData })
      })

    const linkLabelBg = linkGroup.selectAll('rect')
      .data(edges)
      .enter()
      .append('rect')
      .attr('fill', 'rgba(255,255,255,0.95)')
      .attr('rx', 3)
      .attr('ry', 3)
      .style('cursor', 'pointer')
      .style('pointer-events', 'all')
      .style('display', showEdgeLabels ? 'block' : 'none')
      .on('click', (event, edge) => {
        event.stopPropagation()
        clearGraphSelection()
        link.filter((item) => item === edge).attr('stroke', '#3498db').attr('stroke-width', 3)
        d3.select(event.target).attr('fill', 'rgba(52, 152, 219, 0.1)')
        setSelectedItem({ type: 'edge', data: edge.rawData })
      })

    const linkLabels = linkGroup.selectAll('text')
      .data(edges)
      .enter()
      .append('text')
      .text((edge) => edge.name)
      .attr('font-size', '9px')
      .attr('fill', '#666')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .style('cursor', 'pointer')
      .style('pointer-events', 'all')
      .style('font-family', 'var(--font-sans)')
      .style('display', showEdgeLabels ? 'block' : 'none')
      .on('click', (event, edge) => {
        event.stopPropagation()
        clearGraphSelection()
        link.filter((item) => item === edge).attr('stroke', '#3498db').attr('stroke-width', 3)
        d3.select(event.target).attr('fill', '#3498db')
        setSelectedItem({ type: 'edge', data: edge.rawData })
      })

    const nodeGroup = g.append('g').attr('class', 'nodes')
    const node = nodeGroup.selectAll('circle')
      .data(nodes)
      .enter()
      .append('circle')
      .attr('r', 10)
      .attr('fill', (item) => getColor(item.type))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2.5)
      .style('cursor', 'pointer')
      .call(
        d3.drag()
          .on('start', (event, item) => {
            item.fx = item.x
            item.fy = item.y
            item._dragStartX = event.x
            item._dragStartY = event.y
            item._isDragging = false
          })
          .on('drag', (event, item) => {
            const dx = event.x - item._dragStartX
            const dy = event.y - item._dragStartY
            if (!item._isDragging && Math.sqrt(dx * dx + dy * dy) > 3) {
              item._isDragging = true
              simulation.alphaTarget(0.3).restart()
            }
            if (item._isDragging) {
              item.fx = event.x
              item.fy = event.y
            }
          })
          .on('end', (_event, item) => {
            if (item._isDragging) simulation.alphaTarget(0)
            item.fx = null
            item.fy = null
            item._isDragging = false
          }),
      )
      .on('click', (event, item) => {
        event.stopPropagation()
        clearGraphSelection()
        d3.select(event.target).attr('stroke', '#E91E63').attr('stroke-width', 4)
        link.filter((edge) => edge.source.id === item.id || edge.target.id === item.id)
          .attr('stroke', '#E91E63')
          .attr('stroke-width', 2.5)
        setSelectedItem({
          type: 'node',
          data: item.rawData,
          entityType: item.type,
          color: getColor(item.type),
        })
      })
      .on('mouseenter', (event, item) => {
        if (!selectedItem || selectedItem.data?.uuid !== item.rawData.uuid) {
          d3.select(event.target).attr('stroke', '#333').attr('stroke-width', 3)
        }
      })
      .on('mouseleave', (event, item) => {
        if (!selectedItem || selectedItem.data?.uuid !== item.rawData.uuid) {
          d3.select(event.target).attr('stroke', '#fff').attr('stroke-width', 2.5)
        }
      })

    const nodeLabels = nodeGroup.selectAll('text')
      .data(nodes)
      .enter()
      .append('text')
      .text((item) => (item.name.length > 12 ? `${item.name.slice(0, 12)}…` : item.name))
      .attr('font-size', '11px')
      .attr('fill', '#333')
      .attr('font-weight', '500')
      .attr('dx', 14)
      .attr('dy', 4)
      .style('pointer-events', 'none')
      .style('font-family', 'var(--font-sans)')

    const brushLayer = svg.append('g')
      .attr('class', 'brush-layer')
      .style('display', rectSelectMode ? 'block' : 'none')

    const brush = d3.brush()
      .extent([[0, 0], [width, height]])
      .on('end', (event) => {
        if (!rectSelectMode || !event.selection) return

        const [[x0, y0], [x1, y1]] = event.selection
        const minX = transformRef.current.invertX(Math.min(x0, x1))
        const maxX = transformRef.current.invertX(Math.max(x0, x1))
        const minY = transformRef.current.invertY(Math.min(y0, y1))
        const maxY = transformRef.current.invertY(Math.max(y0, y1))

        const selectedNodes = nodes.filter((item) => item.x >= minX && item.x <= maxX && item.y >= minY && item.y <= maxY)
        const selectedNodeIds = new Set(selectedNodes.map((item) => item.id))
        const selectedEdges = edges.filter((item) => selectedNodeIds.has(item.source.id) && selectedNodeIds.has(item.target.id))

        clearGraphSelection()
        if (!selectedNodes.length) {
          brushLayer.call(brush.move, null)
          return
        }

        node.filter((item) => selectedNodeIds.has(item.id)).attr('stroke', '#0f172a').attr('stroke-width', 4)
        link.filter((item) => selectedEdges.includes(item)).attr('stroke', '#2563eb').attr('stroke-width', 3)
        linkLabelBg.filter((item) => selectedEdges.includes(item)).attr('fill', 'rgba(37,99,235,0.10)')
        linkLabels.filter((item) => selectedEdges.includes(item)).attr('fill', '#2563eb')

        setSelectedItem({
          type: 'selection',
          data: buildSelectionSummary(selectedNodes, selectedEdges),
        })
        brushLayer.call(brush.move, null)
      })

    if (rectSelectMode) {
      brushLayer.call(brush)
    }

    simulation.on('tick', () => {
      link.attr('d', (edge) => getLinkPath(edge))

      linkLabels.each(function updateLabel(edge) {
        const mid = getLinkMidpoint(edge)
        d3.select(this).attr('x', mid.x).attr('y', mid.y)
      })

      linkLabelBg.each(function updateLabelBg(edge, index) {
        const mid = getLinkMidpoint(edge)
        const textEl = linkLabels.nodes()[index]
        const bbox = textEl.getBBox()
        d3.select(this)
          .attr('x', mid.x - bbox.width / 2 - 4)
          .attr('y', mid.y - bbox.height / 2 - 2)
          .attr('width', bbox.width + 8)
          .attr('height', bbox.height + 4)
      })

      node.attr('cx', (item) => item.x).attr('cy', (item) => item.y)
      nodeLabels.attr('x', (item) => item.x).attr('y', (item) => item.y)
    })

    svg.on('click', () => {
      clearGraphSelection()
    })

    nodeRef.current = node
    linkRef.current = link
    linkLabelsRef.current = linkLabels
    linkLabelBgRef.current = linkLabelBg
  }

  useEffect(() => {
    scheduleRender()
  }, [graphData, rectSelectMode, entityTypes])

  useEffect(() => {
    const handleResize = () => scheduleRender()
    window.addEventListener('resize', handleResize)
    scheduleRender()

    if (containerRef.current && typeof ResizeObserver !== 'undefined') {
      resizeObserverRef.current = new ResizeObserver(() => scheduleRender())
      resizeObserverRef.current.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current)
      }
      if (simulationRef.current) {
        simulationRef.current.stop()
      }
    }
  }, [])

  return (
    <div className="graph-panel">
      <div className="graph-panel-header">
        <span className="graph-panel-title">Swarm Relationship Graph</span>
        <div className="graph-header-tools">
          <button className="graph-tool-btn" onClick={onRefresh} disabled={loading}>
            <span className={loading ? 'spin' : ''}>↻</span>
            <span>Refresh</span>
          </button>
          <button className={`graph-tool-btn ${rectSelectMode ? 'active' : ''}`} onClick={() => setRectSelectMode((value) => !value)}>
            <span>▭</span>
            <span>Rect Select</span>
          </button>
        </div>
      </div>

      <div className="graph-container" ref={containerRef}>
        {graphData ? (
          <div className="graph-view">
            <svg ref={svgRef} className="graph-svg" />

            {(currentPhase === 1 || isSimulating) && (
              <div className="graph-hint">
                {isSimulating ? 'Swarm memory is updating in real time' : 'Graph is rebuilding from live operator context'}
              </div>
            )}

            {showSimulationFinishedHint && (
              <div className="graph-hint graph-hint-finished">
                <span>The rehearsal finished. Refresh to pull the latest graph memory.</span>
                <button onClick={() => setShowSimulationFinishedHint(false)}>×</button>
              </div>
            )}

            {selectedItem && (
              <div className="graph-detail-panel">
                <div className="graph-detail-head">
                  <span>
                    {selectedItem.type === 'selection' ? 'Selection' : selectedItem.type === 'node' ? 'Node Details' : 'Relationship'}
                  </span>
                  <button onClick={clearGraphSelection}>×</button>
                </div>

                {selectedItem.type === 'selection' && (
                  <div className="graph-detail-body">
                    <div className="graph-detail-row"><span>Nodes</span><span>{selectedItem.data.nodeCount}</span></div>
                    <div className="graph-detail-row"><span>Edges</span><span>{selectedItem.data.edgeCount}</span></div>
                    <div className="graph-detail-row"><span>Components</span><span>{selectedItem.data.componentCount}</span></div>
                    {selectedItem.data.types?.length ? (
                      <div className="graph-detail-section">
                        <div className="graph-detail-section-title">Entity Types</div>
                        <div className="graph-tag-list">
                          {selectedItem.data.types.map((type) => (
                            <span key={type.name} className="graph-tag">{type.name} · {type.count}</span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {selectedItem.type === 'node' && (
                  <div className="graph-detail-body">
                    <div className="graph-detail-row"><span>Name</span><span>{selectedItem.data.name}</span></div>
                    <div className="graph-detail-row"><span>UUID</span><span className="uuid-text">{selectedItem.data.uuid}</span></div>
                    {selectedItem.data.created_at ? (
                      <div className="graph-detail-row"><span>Created</span><span>{formatDateTime(selectedItem.data.created_at)}</span></div>
                    ) : null}
                    {selectedItem.data.summary ? (
                      <div className="graph-detail-section">
                        <div className="graph-detail-section-title">Summary</div>
                        <p>{selectedItem.data.summary}</p>
                      </div>
                    ) : null}
                  </div>
                )}

                {selectedItem.type === 'edge' && (
                  <div className="graph-detail-body">
                    <div className="graph-detail-row"><span>Path</span><span>{selectedItem.data.source_name} → {selectedItem.data.target_name}</span></div>
                    <div className="graph-detail-row"><span>Label</span><span>{selectedItem.data.name || 'RELATED_TO'}</span></div>
                    <div className="graph-detail-row"><span>Type</span><span>{selectedItem.data.fact_type || 'Unknown'}</span></div>
                    {selectedItem.data.fact ? (
                      <div className="graph-detail-section">
                        <div className="graph-detail-section-title">Fact</div>
                        <p>{selectedItem.data.fact}</p>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="graph-state">Loading swarm graph…</div>
        ) : (
          <div className="graph-state">Waiting for graph context…</div>
        )}
      </div>

      {graphData && entityTypes.length ? (
        <div className="graph-legend">
          <span className="graph-legend-title">Entity Types</span>
          <div className="graph-legend-items">
            {entityTypes.map((type) => (
              <div key={type.name} className="graph-legend-item">
                <span className="graph-legend-dot" style={{ background: type.color }} />
                <span>{type.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {graphData ? (
        <div className="edge-labels-toggle">
          <label className="toggle-switch">
            <input type="checkbox" checked={showEdgeLabels} onChange={(event) => setShowEdgeLabels(event.target.checked)} />
            <span className="slider" />
          </label>
          <span>Show Edge Labels</span>
        </div>
      ) : null}
    </div>
  )
}
