// ==UserScript==
// @name         Coinglass Heatmap Tools (Dev Build)
// @namespace    coinglass-heatmap-tools
// @version      0.3
// @description  Adds analytical tooling to Coinglass liquidation heatmap
// @match        https://www.coinglass.com/*
// @match        https://coinglass.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function installHeatmapWatcher() {
  console.log("Heatmap watcher booting... category-axis resolver enabled (14)");

  /* -------------------------------------------------
    FOUNDATION 1 — DATA EXTRACTION (unchanged)
  ------------------------------------------------- */

  let lastUpdateTime = null;

  function findHeatmapData() {
    const rootEl = document.querySelector("#__next");
    if (!rootEl) return null;

    const reactKey = Object.keys(rootEl).find(k => k.startsWith("__reactContainer$"));
    if (!reactKey) return null;

    const fiberRoot = rootEl[reactKey];
    let found = null;

    function scan(node) {
      if (!node || found) return;

      try {
        const buckets = [node.memoizedState, node.memoizedProps, node.stateNode?.state].filter(Boolean);

        for (const obj of buckets) {
          if (obj?.data?.liq && obj?.data?.y && obj?.data?.prices) {
            found = obj.data;
            return;
          }

          if (obj?.liq && obj?.y && obj?.prices) {
            found = obj;
            return;
          }
        }
      } catch { }

      scan(node.child);
      scan(node.sibling);
    }

    scan(fiberRoot);
    return found;
  }

  function updateDataset() {
    const data = findHeatmapData();
    if (!data) return;
    if (data.updateTime === lastUpdateTime) return;

    lastUpdateTime = data.updateTime;
    window.__liqHeatmapData = data;
    window.__liqClusters = data.liq.map(([t, p, v]) => ({ timeIndex: t, priceIndex: p, price: data.y[p], liquidity: v }));

    renderOverlay(computeNearestClusters(data, window.__liqClusters));
    console.log("Heatmap dataset updated:", __liqClusters.length, "clusters");
  }

  setInterval(updateDataset, 1500);

  /* -------------------------------------------------
    FOUNDATION 2 — FIND ECHARTS INSTANCE
  ------------------------------------------------- */

  function getHeatmapInstance() {
    if (window.__heatmapInst) return window.__heatmapInst;

    const wrapper = document.querySelector(".echarts-for-react");
    if (!wrapper) return null;

    const fiberKey = Object.keys(wrapper).find(k => k.startsWith("__reactFiber$"));
    if (!fiberKey) return null;

    let fiber = wrapper[fiberKey];

    for (let i = 0; i < 8 && fiber; i++) {
      if (fiber.tag === 1 && fiber.stateNode && fiber.memoizedProps?.option) {

        try {
          const inst = fiber.stateNode.getEchartsInstance();
          if (inst) {
            window.__heatmapInst = inst;
            return inst;
          }

        } catch { }
      }

      fiber = fiber.return;
    }

    return null;
  }

  /* -------------------------------------------------
    FOUNDATION 3 — CATEGORY ROW RESOLVER
  ------------------------------------------------- */

  function buildRowGeometry() {
    const inst = getHeatmapInstance();
    if (!inst) return null;

    const option = inst.getOption();
    const categoryAxisIndex = option.yAxis.findIndex(a => a.type === "category");
    const categoryAxis = option.yAxis[categoryAxisIndex];
    if (!categoryAxis) return null;

    const ladder = categoryAxis.data;
    const buildLog = { ladderLength: ladder.length, instExists: !!inst, categoryAxisIndex };
    console.log("[Resolver] Built with state:", JSON.stringify(buildLog));

    const rect = inst.getDom().getBoundingClientRect();
    const rows = ladder.map((price, rowIndex) => {
      try {
        const pixel = inst.convertToPixel({ yAxisIndex: categoryAxisIndex }, rowIndex);
        const centerY = Array.isArray(pixel) ? pixel[1] : pixel;
        if (!Number.isFinite(centerY)) return null;

        return { rowIndex, price, centerY };
      } catch {
        return null;
      }
    }).filter(Boolean).sort((a, b) => a.centerY - b.centerY).map((row, visualIndex, arr) => {
      const prev = arr[visualIndex - 1];
      const next = arr[visualIndex + 1];

      return {
        ...row,
        visualIndex,
        topBoundary: prev ? (prev.centerY + row.centerY) / 2 : -Infinity,
        bottomBoundary: next ? (row.centerY + next.centerY) / 2 : Infinity
      };
    });

    if (!rows.length) return null;

    return { rect, ladder, rows };
  }

  function resolveRowFromClientY(geometry, clientY) {
    const localY = clientY - geometry.rect.top;
    let row = geometry.rows.find(candidate => localY >= candidate.topBoundary && localY < candidate.bottomBoundary);

    if (!row) {
      row = geometry.rows.reduce((best, candidate) => {
        if (!best) return candidate;
        return Math.abs(candidate.centerY - localY) < Math.abs(best.centerY - localY) ? candidate : best;
      }, null);
    }

    if (!row) return null;

    const result = {
      clientY,
      localY,
      rowIndex: row.rowIndex,
      visualIndex: row.visualIndex,
      price: row.price,
      centerY: row.centerY,
      topBoundary: row.topBoundary,
      bottomBoundary: row.bottomBoundary
    };
    console.log("[Resolution] Success:", JSON.stringify(result));
    return result;
  }

  /* -------------------------------------------------
    ANALYTICS LAYER
  ------------------------------------------------- */

  function getCurrentPrice(data) {
    const last = data.prices[data.prices.length - 1];
    return Number(last[4]);
  }

  function normalizePriceValue(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;

    const normalized = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(normalized) ? normalized : null;
  }

  function getRenderedLadder() {
    const geometry = buildRowGeometry();
    return geometry?.ladder || [];
  }

  function getInclusiveRowRange(geometry, a, b) {
    const minLocalY = Math.min(a.localY, b.localY);
    const maxLocalY = Math.max(a.localY, b.localY);
    const intersectingRows = geometry.rows.filter(row => maxLocalY >= row.topBoundary && minLocalY < row.bottomBoundary);

    if (!intersectingRows.length) {
      const lowIndex = Math.min(a.rowIndex, b.rowIndex);
      const highIndex = Math.max(a.rowIndex, b.rowIndex);

      return {
        minIndex: lowIndex,
        maxIndex: highIndex,
        topIndex: a.localY <= b.localY ? a.rowIndex : b.rowIndex,
        bottomIndex: a.localY <= b.localY ? b.rowIndex : a.rowIndex
      };
    }

    const indexList = intersectingRows.map(row => row.rowIndex);
    const topRow = intersectingRows[0];
    const bottomRow = intersectingRows[intersectingRows.length - 1];

    return {
      minIndex: Math.min(...indexList),
      maxIndex: Math.max(...indexList),
      topIndex: topRow.rowIndex,
      bottomIndex: bottomRow.rowIndex
    };
  }

  function computeNearestClusters(data, clusters) {
    const price = getCurrentPrice(data);
    const latest = data.prices.length - 1;
    const rows = clusters.filter(c => c.timeIndex === latest);
    const above = rows.filter(c => c.price > price);
    const below = rows.filter(c => c.price < price);

    above.sort((a, b) => a.price - b.price);
    below.sort((a, b) => b.price - a.price);

    return {
      currentPrice: price,
      nearestAbove: above[0],
      nearestBelow: below[0],
      totalAbove: above.reduce((s, c) => s + c.liquidity, 0),
      totalBelow: below.reduce((s, c) => s + c.liquidity, 0)
    };
  }

  function computeRegionStats(minIndex, maxIndex) {
    const data = window.__liqHeatmapData;
    if (!data) return null;

    const latest = data.prices.length - 1;
    const allLatestClusters = (Array.isArray(window.__liqClusters) ? window.__liqClusters : []).filter(c => c.timeIndex === latest);
    const ladder = getRenderedLadder();
    const selected = allLatestClusters.filter(c => c.priceIndex >= minIndex && c.priceIndex <= maxIndex);
    const selectedLiquidity = selected.reduce((sum, cluster) => sum + (Number(cluster.liquidity) || 0), 0);
    const selectedRowCount = maxIndex - minIndex + 1;
    const selectedRows = [];

    for (let priceIndex = minIndex; priceIndex <= maxIndex; priceIndex++) {
      const cluster = selected.find(item => item.priceIndex === priceIndex) || null;
      selectedRows.push({
        priceIndex,
        price: ladder[priceIndex],
        hasLatestCluster: !!cluster,
        liquidity: cluster ? cluster.liquidity : 0
      });
    }

    // Add detailed logging
    const debugLog = {
      minIndex,
      maxIndex,
      minPrice: ladder[minIndex],
      maxPrice: ladder[maxIndex],
      rangeSize: maxIndex - minIndex + 1,
      ladderLength: ladder.length,
      totalClustersAtLatestTime: allLatestClusters.length,
      selectedRowCount,
      matchedByLatestPriceIndex: selected.length,
      totalSelectedLiquidity: selectedLiquidity,
      priceIndexRangeAtLatest: allLatestClusters.length > 0 ? {
        min: Math.min(...allLatestClusters.map(c => c.priceIndex)),
        max: Math.max(...allLatestClusters.map(c => c.priceIndex))
      } : null,
      selectedRows,
      selectedSample: selected.slice(0, 3).map(c => ({
        priceIndex: c.priceIndex,
        price: c.price.toFixed(2),
        liquidity: c.liquidity
      }))
    };
    console.log("[ComputeStats] Debug:", JSON.stringify(debugLog));

    return {
      clusterCount: selectedRowCount,
      activeClusterCount: selected.length,
      totalLiquidity: selectedLiquidity
    };
  }

  /* -------------------------------------------------
    UI LAYER
  ------------------------------------------------- */

  function getResolver() {
    const geometry = buildRowGeometry();
    if (!geometry) return null;

    return function clientYToRow(clientY) {
      return resolveRowFromClientY(geometry, clientY);
    };
  }


  function ensureOverlayPanel() {
    let panel = document.getElementById("liq-tools-panel");

    if (!panel) {
      panel = document.createElement("div");
      panel.id = "liq-tools-panel";

      Object.assign(panel.style, {
        position: "fixed",
        top: "110px",
        right: "10px",
        zIndex: 999999,
        background: "#111",
        color: "#fff",
        padding: "14px",
        border: "1px solid #fff",
        borderRadius: "10px",
        fontFamily: "monospace",
        fontSize: "13px"
      });

      document.body.appendChild(panel);
    }

    return panel;
  }

  function renderOverlay(stats) {
    const panel = ensureOverlayPanel();
    const bias = stats.totalAbove > stats.totalBelow ? "UPWARD" : "DOWNWARD";

    panel.innerHTML = `
      <b>Liquidation Tools</b><br><br>
      Price: ${stats.currentPrice.toFixed(2)}<br><br>
      Nearest Above:<br>
      ${stats.nearestAbove?.price.toFixed(2)}<br>
      $${Math.round(stats.nearestAbove?.liquidity).toLocaleString()}<br><br>
      Nearest Below:<br>
      ${stats.nearestBelow?.price.toFixed(2)}<br>
      $${Math.round(stats.nearestBelow?.liquidity).toLocaleString()}<br><br>
      Bias: ${bias}
    `;
  }

  /* ---------- region panel ---------- */

  function renderRegionOverlay(min, max, stats) {
    let box = document.getElementById("liq-region-panel");

    if (!box) {
      box = document.createElement("div");
      box.id = "liq-region-panel";

      Object.assign(box.style, {
        position: "fixed",
        left: "10px",
        top: "110px",
        zIndex: 999999,
        background: "#111",
        color: "#fff",
        padding: "14px",
        border: "1px solid #fff",
        borderRadius: "10px",
        fontFamily: "monospace"
      });

      document.body.appendChild(box);
    }

    box.innerHTML = `
      <b>Selected Region</b><br><br>
      Top: ${max.toFixed(2)}<br>
      Bottom: ${min.toFixed(2)}<br><br>
      Rows: ${stats.clusterCount}<br>
      Clusters: ${stats.activeClusterCount}<br>
      Liquidity: $${Math.round(stats.totalLiquidity).toLocaleString()}
    `;
  }

  /* -------------------------------------------------
    DRAG SELECTION
  ------------------------------------------------- */

  let selection = { active: false, startY: null, endY: null };

  function installDragSelection() {
    const container = getHeatmapInstance()?.getDom();
    if (!container) return;

    container.addEventListener("mousedown", e => {
      selection.active = true;
      selection.startY = e.clientY;
      selection.endY = null;
    });

    container.addEventListener("mousemove", e => {
      if (selection.active && selection.startY !== null) {
        selection.endY = e.clientY;
      }
    });

    container.addEventListener("mouseup", e => {
      if (!selection.active) return;

      selection.active = false;
      selection.endY = e.clientY;

      if (selection.startY !== null && selection.endY !== null) {
        handleSelection();
      }
    });

    document.addEventListener("mouseup", e => {
      selection.active = false;
    });
  }

  function handleSelection() {
    const selectionLog = JSON.stringify({ startY: selection.startY, endY: selection.endY });
    console.log("[Selection] Starting with:", selectionLog);

    // Try to resolve both endpoints, with a second attempt if first fails
    const resolve1 = getResolver();
    if (!resolve1) {
      console.warn("[Selection] Failed to build initial resolver");
      return;
    }

    let a = resolve1(selection.startY);

    // If startY failed, try rebuilding resolver and retry once
    if (!a) {
      console.log("[Selection] First resolution of startY failed, retrying with fresh resolver");
      const resolve2 = getResolver();
      a = resolve2(selection.startY);
    }

    const b = resolve1(selection.endY);

    // If endY failed, try with fresh resolver
    let b_final = b;
    if (!b) {
      console.log("[Selection] Resolution of endY failed, retrying with fresh resolver");
      const resolve3 = getResolver();
      b_final = resolve3(selection.endY);
    }

    const resolutionLog = JSON.stringify({
      a_success: !!a,
      b_success: !!b_final,
      a: a ? { localY: a.localY, rowIndex: a.rowIndex, visualIndex: a.visualIndex, price: a.price } : null,
      b: b_final ? { localY: b_final.localY, rowIndex: b_final.rowIndex, visualIndex: b_final.visualIndex, price: b_final.price } : null,
      startY: selection.startY,
      endY: selection.endY
    });
    console.log("[Selection] Resolution results:", resolutionLog);

    if (!a || !b_final) {
      console.warn("[Selection] Failed to resolve both endpoints after retry", resolutionLog);
      return;
    }

    const geometry = buildRowGeometry();
    if (!geometry || !geometry.ladder.length) {
      console.warn("[Selection] No rendered ladder found");
      return;
    }

    const range = getInclusiveRowRange(geometry, a, b_final);
    const topPrice = normalizePriceValue(geometry.ladder[range.topIndex]);
    const bottomPrice = normalizePriceValue(geometry.ladder[range.bottomIndex]);

    // Log the indices being passed to compute stats
    const indicesLog = JSON.stringify({
      minIndex: range.minIndex,
      maxIndex: range.maxIndex,
      topIndex: range.topIndex,
      bottomIndex: range.bottomIndex,
      startLocalY: a.localY,
      endLocalY: b_final.localY,
      topPrice,
      bottomPrice
    });
    console.log("[Selection] Calling computeRegionStats with indices:", indicesLog);

    const stats = computeRegionStats(range.minIndex, range.maxIndex);
    if (!stats || topPrice === null || bottomPrice === null) {
      console.warn("[Selection] Failed to compute stats or display prices", JSON.stringify({ statsExists: !!stats, topPrice, bottomPrice }));
      return;
    }

    console.log("[Selection] Computed stats:", JSON.stringify({
      minIndex: range.minIndex,
      maxIndex: range.maxIndex,
      topIndex: range.topIndex,
      bottomIndex: range.bottomIndex,
      topPrice: topPrice.toFixed(2),
      bottomPrice: bottomPrice.toFixed(2),
      clusters: stats.clusterCount,
      liquidity: stats.totalLiquidity
    }));
    renderRegionOverlay(bottomPrice, topPrice, stats);
  }

  setTimeout(installDragSelection, 3000);
})();
