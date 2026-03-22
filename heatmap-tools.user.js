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
  console.log("Heatmap watcher booting... category-axis resolver enabled (28)");

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
    const xAxes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis].filter(Boolean);
    const primaryXAxisIndex = xAxes.findIndex(Boolean);

    const ladder = categoryAxis.data;

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

    let plotLeft = 0;
    let plotRight = rect.width;
    if (primaryXAxisIndex >= 0) {
      try {
        const leftPixel = inst.convertToPixel({ xAxisIndex: primaryXAxisIndex }, 0);
        const rightPixel = inst.convertToPixel({ xAxisIndex: primaryXAxisIndex }, xAxes[primaryXAxisIndex]?.data?.length - 1 || 0);
        const leftValue = Array.isArray(leftPixel) ? leftPixel[0] : leftPixel;
        const rightValue = Array.isArray(rightPixel) ? rightPixel[0] : rightPixel;

        if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
          plotLeft = Math.max(0, Math.min(leftValue, rightValue));
          plotRight = Math.min(rect.width, Math.max(leftValue, rightValue));
        }
      } catch { }
    }

    return { rect, ladder, rows, plotLeft, plotRight };
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

    return {
      clientY,
      localY,
      rowIndex: row.rowIndex,
      visualIndex: row.visualIndex,
      price: row.price,
      centerY: row.centerY,
      topBoundary: row.topBoundary,
      bottomBoundary: row.bottomBoundary
    };
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

  function formatCurrency(value) {
    const numericValue = Number(value) || 0;
    return numericValue.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatPercentDistance(value, referencePrice) {
    const numericValue = Number(value);
    const numericReference = Number(referencePrice);
    if (!Number.isFinite(numericValue) || !Number.isFinite(numericReference) || numericReference === 0) {
      return "0.00";
    }

    return (Math.abs(numericValue - numericReference) / Math.abs(numericReference) * 100).toFixed(2);
  }

  function formatPriceWithDistance(value, currentPrice) {
    return `${formatCurrency(value)} (${formatPercentDistance(value, currentPrice)}%)`;
  }

  function getRenderedLadder() {
    const geometry = buildRowGeometry();
    return geometry?.ladder || [];
  }

  function ensureSelectionOverlay() {
    let overlay = document.getElementById("liq-selection-overlay");

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "liq-selection-overlay";

      Object.assign(overlay.style, {
        position: "absolute",
        pointerEvents: "none",
        display: "none",
        boxSizing: "border-box",
        borderTop: "2px solid #ff6b6b",
        borderBottom: "2px solid #ff6b6b",
        background: "linear-gradient(180deg, rgba(255,107,107,0.30), rgba(255,107,107,0.14))",
        boxShadow: "0 0 0 1px rgba(255,107,107,0.26) inset"
      });
    }

    const container = getHeatmapInstance()?.getDom();
    if (!container) return null;

    const containerStyle = window.getComputedStyle(container);
    if (containerStyle.position === "static") {
      container.style.position = "relative";
    }

    if (overlay.parentElement !== container) {
      container.appendChild(overlay);
    }

    return overlay;
  }

  function clearSelectionHighlight() {
    const overlay = document.getElementById("liq-selection-overlay");
    if (!overlay) return;

    overlay.style.display = "none";
  }

  function ensureCurrentPriceOverlay() {
    let overlay = document.getElementById("liq-current-price-overlay");

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "liq-current-price-overlay";

      Object.assign(overlay.style, {
        position: "absolute",
        pointerEvents: "none",
        display: "none",
        background: "rgba(0,0,0,0.35)",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.18) inset"
      });
    }

    const container = getHeatmapInstance()?.getDom();
    if (!container) return null;

    const containerStyle = window.getComputedStyle(container);
    if (containerStyle.position === "static") {
      container.style.position = "relative";
    }

    if (overlay.parentElement !== container) {
      container.appendChild(overlay);
    }

    return overlay;
  }

  function drawCurrentPriceHighlight(currentPrice) {
    const geometry = buildRowGeometry();
    const overlay = ensureCurrentPriceOverlay();
    if (!geometry || !overlay) return;

    const rowIndex = findNearestPriceRowIndex(geometry.ladder, currentPrice);
    const row = geometry.rows.find(item => item.rowIndex === rowIndex);
    if (!row) {
      overlay.style.display = "none";
      return;
    }

    const top = Math.max(0, row.topBoundary === -Infinity ? 0 : row.topBoundary);
    const bottom = Math.min(geometry.rect.height, row.bottomBoundary === Infinity ? geometry.rect.height : row.bottomBoundary);
    const left = Math.max(0, geometry.plotLeft);
    const right = Math.min(geometry.rect.width, geometry.plotRight);

    Object.assign(overlay.style, {
      display: "block",
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(2, right - left)}px`,
      height: `${Math.max(1, bottom - top)}px`
    });
  }

  function ensureSelectionCounter() {
    let counter = document.getElementById("liq-selection-counter");

    if (!counter) {
      counter = document.createElement("div");
      counter.id = "liq-selection-counter";

      Object.assign(counter.style, {
        position: "fixed",
        zIndex: 1000000,
        display: "none",
        pointerEvents: "none",
        background: "#111",
        color: "#fff",
        padding: "6px 10px",
        border: "1px solid #fff",
        borderRadius: "10px",
        fontFamily: "monospace",
        fontSize: "13px",
        lineHeight: "1.3",
        boxShadow: "0 6px 18px rgba(0,0,0,0.30)"
      });

      document.body.appendChild(counter);
    }

    return counter;
  }

  function hideSelectionCounter() {
    const counter = document.getElementById("liq-selection-counter");
    if (!counter) return;

    counter.style.display = "none";
  }

  function updateSelectionCounter(rowCount) {
    const counter = ensureSelectionCounter();
    if (!counter) return;
    const toolsPanel = ensureOverlayPanel();
    const panelRect = toolsPanel.getBoundingClientRect();

    counter.textContent = `${rowCount} row${rowCount === 1 ? "" : "s"}`;
    Object.assign(counter.style, {
      display: "block",
      left: `${panelRect.left}px`,
      top: `${panelRect.bottom + 8}px`,
      minWidth: `${panelRect.width}px`,
      textAlign: "center"
    });
  }

  function drawSelectionHighlight(geometry, range) {
    const overlay = ensureSelectionOverlay();
    if (!overlay) return;

    const topRow = geometry.rows.find(row => row.rowIndex === range.topIndex);
    const bottomRow = geometry.rows.find(row => row.rowIndex === range.bottomIndex);
    if (!topRow || !bottomRow) {
      clearSelectionHighlight();
      return;
    }

    const top = Math.max(0, topRow.topBoundary === -Infinity ? 0 : topRow.topBoundary);
    const bottom = Math.min(geometry.rect.height, bottomRow.bottomBoundary === Infinity ? geometry.rect.height : bottomRow.bottomBoundary);
    const left = Math.max(0, geometry.plotLeft);
    const right = Math.min(geometry.rect.width, geometry.plotRight);

    Object.assign(overlay.style, {
      display: "block",
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(2, right - left)}px`,
      height: `${Math.max(2, bottom - top)}px`
    });
  }

  function closeRegionOverlay() {
    const box = document.getElementById("liq-region-panel");
    if (box) box.remove();
    clearSelectionHighlight();
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
    const ladder = Array.isArray(data.y) ? data.y : [];
    const currentPriceRowIndex = findNearestPriceRowIndex(ladder, price);
    const maxRowsAbove = Math.max(0, ladder.length - 1 - currentPriceRowIndex);
    const maxRowsBelow = Math.max(0, currentPriceRowIndex);
    const biasRowsChecked = Math.min(maxRowsAbove, maxRowsBelow);
    const minBiasIndex = Math.max(0, currentPriceRowIndex - biasRowsChecked);
    const maxBiasIndex = Math.min(ladder.length - 1, currentPriceRowIndex + biasRowsChecked);
    const rows = clusters.filter(c => c.timeIndex === latest);
    const rowsInBiasWindow = rows.filter(c => c.priceIndex >= minBiasIndex && c.priceIndex <= maxBiasIndex);
    const above = rowsInBiasWindow.filter(c => c.priceIndex > currentPriceRowIndex);
    const below = rowsInBiasWindow.filter(c => c.priceIndex < currentPriceRowIndex);

    above.sort((a, b) => a.price - b.price);
    below.sort((a, b) => b.price - a.price);

    return {
      currentPrice: price,
      currentPriceRowIndex,
      nearestAbove: above[0],
      nearestBelow: below[0],
      totalAbove: above.reduce((s, c) => s + c.liquidity, 0),
      totalBelow: below.reduce((s, c) => s + c.liquidity, 0),
      biasRowsChecked
    };
  }

  function findNearestPriceRowIndex(ladder, targetPrice) {
    let bestIndex = -1;
    let bestDiff = Infinity;

    ladder.forEach((price, rowIndex) => {
      const numericPrice = normalizePriceValue(price);
      if (numericPrice === null) return;

      const diff = Math.abs(numericPrice - targetPrice);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = rowIndex;
      }
    });

    return bestIndex;
  }

  function buildSelectionDistance(currentPrice, currentPriceRowIndex, topIndex, bottomIndex, ladder) {
    const topPrice = normalizePriceValue(ladder[topIndex]);
    const bottomPrice = normalizePriceValue(ladder[bottomIndex]);
    if (topPrice === null || bottomPrice === null || currentPriceRowIndex < 0) return null;

    if (currentPrice < bottomPrice) {
      return {
        anchor: "bottom",
        rows: Math.abs(bottomIndex - currentPriceRowIndex),
        priceDistance: Math.abs(bottomPrice - currentPrice),
        edgePrice: bottomPrice
      };
    }

    if (currentPrice > topPrice) {
      return {
        anchor: "top",
        rows: Math.abs(topIndex - currentPriceRowIndex),
        priceDistance: Math.abs(currentPrice - topPrice),
        edgePrice: topPrice
      };
    }

    return {
      anchor: "inside",
      rows: 0,
      priceDistance: 0,
      edgePrice: currentPrice
    };
  }

  function computeRegionStats(minIndex, maxIndex) {
    const data = window.__liqHeatmapData;
    if (!data) return null;

    const latest = data.prices.length - 1;
    const allLatestClusters = (Array.isArray(window.__liqClusters) ? window.__liqClusters : []).filter(c => c.timeIndex === latest);
    const ladder = getRenderedLadder();
    const currentPrice = getCurrentPrice(data);
    const currentPriceRowIndex = findNearestPriceRowIndex(ladder, currentPrice);
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

    return {
      clusterCount: selectedRowCount,
      activeClusterCount: selected.length,
      totalLiquidity: selectedLiquidity,
      currentPrice,
      currentPriceRowIndex
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
        fontSize: "13px",
        lineHeight: "1.45"
      });

      document.body.appendChild(panel);
    }

    return panel;
  }

  function renderOverlay(stats) {
    const panel = ensureOverlayPanel();
    const bias = stats.totalAbove > stats.totalBelow ? "UPWARD" : "DOWNWARD";
    drawCurrentPriceHighlight(stats.currentPrice);

    panel.innerHTML = `
      <b>Liquidation Tools</b><br><br>
      Price: ${formatPriceWithDistance(stats.currentPrice, stats.currentPrice)}<br><br>
      Nearest Above:<br>
      ${formatPriceWithDistance(stats.nearestAbove?.price, stats.currentPrice)}<br>
      ${formatCurrency(stats.nearestAbove?.liquidity)}<br><br>
      Nearest Below:<br>
      ${formatPriceWithDistance(stats.nearestBelow?.price, stats.currentPrice)}<br>
      ${formatCurrency(stats.nearestBelow?.liquidity)}<br><br>
      Bias: ${bias}<br>
      (${stats.biasRowsChecked} rows checked)
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
        fontFamily: "monospace",
        fontSize: "13px",
        lineHeight: "1.45"
      });

      document.body.appendChild(box);
    }

    const distanceLine = stats.distance?.anchor === "inside"
      ? `Distance: 0 rows [inside]<br>${formatCurrency(0)} - 0.00%`
      : stats.distance
        ? `Distance: ${stats.distance.rows} rows<br>${formatCurrency(stats.distance.priceDistance)} - ${formatPercentDistance(stats.distance.edgePrice, stats.currentPrice)}%`
        : `Distance: n/a`;

    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <b>Selected Region</b>
        <button id="liq-region-close" style="background:#1b1b1b;color:#fff;border:1px solid #fff;border-radius:6px;padding:0px 8px 2px;font:inherit;cursor:pointer;">x</button>
      </div><br>
      Price: ${formatPriceWithDistance(stats.currentPrice, stats.currentPrice)}<br><br>
      Top: ${formatPriceWithDistance(max, stats.currentPrice)}<br>
      Bottom: ${formatPriceWithDistance(min, stats.currentPrice)}<br><br>
      ${distanceLine}<br><br>
      Rows: ${stats.clusterCount}<br>
      Clusters: ${stats.activeClusterCount}<br>
      Liquidity: ${formatCurrency(stats.totalLiquidity)}
    `;

    const closeButton = document.getElementById("liq-region-close");
    if (closeButton) {
      closeButton.onclick = closeRegionOverlay;
    }
  }

  /* -------------------------------------------------
    DRAG SELECTION
  ------------------------------------------------- */

  let selection = { active: false, startY: null, endY: null, pointerId: null };

  function finalizeSelection(clientY) {
    if (!selection.active) return;

    selection.active = false;
    selection.endY = clientY;
    selection.pointerId = null;
    hideSelectionCounter();

    if (selection.startY !== null && selection.endY !== null) {
      handleSelection();
    }
  }

  function updateLiveSelectionCounter(clientY) {
    if (!selection.active || selection.startY === null) return;

    const geometry = buildRowGeometry();
    if (!geometry) return;

    const startRow = resolveRowFromClientY(geometry, selection.startY);
    const currentRow = resolveRowFromClientY(geometry, clientY);
    if (!startRow || !currentRow) return;

    const liveRange = getInclusiveRowRange(geometry, startRow, currentRow);
    updateSelectionCounter(liveRange.maxIndex - liveRange.minIndex + 1);
  }

  function installDragSelection() {
    const container = getHeatmapInstance()?.getDom();
    if (!container) return;

    container.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      clearSelectionHighlight();
      hideSelectionCounter();
      selection.active = true;
      selection.pointerId = e.pointerId;
      selection.startY = e.clientY;
      selection.endY = null;
      updateLiveSelectionCounter(e.clientY);
      try {
        container.setPointerCapture(e.pointerId);
      } catch { }
    });

    document.addEventListener("pointermove", e => {
      if (!selection.active) return;
      if (selection.pointerId !== null && e.pointerId !== selection.pointerId) return;
      selection.endY = e.clientY;
      updateLiveSelectionCounter(e.clientY);
    }, true);

    container.addEventListener("pointerup", e => {
      if (!selection.active) return;
      if (selection.pointerId !== null && e.pointerId !== selection.pointerId) return;
      finalizeSelection(e.clientY);
    });

    document.addEventListener("pointerup", e => {
      if (!selection.active) return;
      if (selection.pointerId !== null && e.pointerId !== selection.pointerId) return;
      finalizeSelection(e.clientY);
    }, true);

    container.addEventListener("lostpointercapture", e => {
      if (!selection.active) return;
      if (selection.pointerId !== null && e.pointerId !== selection.pointerId) return;
      finalizeSelection(selection.endY ?? selection.startY);
    });

    container.addEventListener("pointercancel", e => {
      if (!selection.active) return;
      if (selection.pointerId !== null && e.pointerId !== selection.pointerId) return;
      finalizeSelection(selection.endY ?? selection.startY);
    });
  }

  function handleSelection() {
    const resolve1 = getResolver();
    if (!resolve1) return;

    let a = resolve1(selection.startY);

    if (!a) {
      const resolve2 = getResolver();
      a = resolve2(selection.startY);
    }

    const b = resolve1(selection.endY);

    let b_final = b;
    if (!b) {
      const resolve3 = getResolver();
      b_final = resolve3(selection.endY);
    }

    if (!a || !b_final) return;

    const geometry = buildRowGeometry();
    if (!geometry || !geometry.ladder.length) return;

    const range = getInclusiveRowRange(geometry, a, b_final);
    const topPrice = normalizePriceValue(geometry.ladder[range.topIndex]);
    const bottomPrice = normalizePriceValue(geometry.ladder[range.bottomIndex]);

    const stats = computeRegionStats(range.minIndex, range.maxIndex);
    if (!stats || topPrice === null || bottomPrice === null) return;

    stats.distance = buildSelectionDistance(
      stats.currentPrice,
      stats.currentPriceRowIndex,
      range.topIndex,
      range.bottomIndex,
      geometry.ladder
    );

    drawSelectionHighlight(geometry, range);
    renderRegionOverlay(bottomPrice, topPrice, stats);
  }

  setTimeout(installDragSelection, 3000);
})();
