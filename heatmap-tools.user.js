// ==UserScript==
// @name         Coinglass Heatmap Tools (Dev Build)
// @namespace    coinglass-heatmap-tools
// @version      0.47
// @description  Adds analytical tooling to Coinglass liquidation heatmap
// @match        https://www.coinglass.com/*
// @match        https://coinglass.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function installHeatmapWatcher() {
  console.log("Heatmap watcher booting - 0.47");

  const SELECTION_STYLES = [
    {
      border: "#ff6b6b",
      background: "linear-gradient(180deg, rgba(255,107,107,0.30), rgba(255,107,107,0.14))",
      inset: "0 0 0 1px rgba(255,107,107,0.26) inset",
      panelBorder: "#ff6b6b"
    },
    {
      border: "#f2e8c9",
      background: "linear-gradient(180deg, rgba(242,232,201,0.28), rgba(242,232,201,0.12))",
      inset: "0 0 0 1px rgba(242,232,201,0.26) inset",
      panelBorder: "#f2e8c9"
    }
  ];

  let savedSelections = [];
  let overlayCollapsed = false;

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

  function formatRatio(value) {
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(2);
  }

  function formatCompactMetric(value) {
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(2);
  }

  function formatSignedMetric(value) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(2);
  }

  function safeDivide(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return NaN;
    if (denominator === 0) return numerator > 0 ? Infinity : 0;
    return numerator / denominator;
  }

  function normalizeDirectionalScore(aboveValue, belowValue) {
    const above = Number(aboveValue);
    const below = Number(belowValue);

    if (above === Infinity && below === Infinity) return 0;
    if (above === Infinity) return 1;
    if (below === Infinity) return -1;
    if (!Number.isFinite(above) || !Number.isFinite(below)) return NaN;

    const total = above + below;
    if (total === 0) return 0;

    const normalized = (above - below) / total;
    return Math.max(-1, Math.min(1, normalized));
  }

  function classifyDirectionalShort(score) {
    if (!Number.isFinite(score)) return "n/a";
    if (score > 0) return "UP";
    if (score < 0) return "DOWN";
    return "FLAT";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderStatLabel(label, tooltipText) {
    if (!tooltipText) return `<span>${escapeHtml(label)}</span>`;

    return `<span>${escapeHtml(label)} <span class="liq-info-tip" title="${escapeHtml(tooltipText)}">i</span></span>`;
  }

  function renderStatRow(label, value, tooltipText) {
    return `
      <div class="liq-stat-row">
        <div class="liq-stat-label">${renderStatLabel(label, tooltipText)}</div>
        <div class="liq-stat-value">${value}</div>
      </div>
    `;
  }

  function renderSectionHeading(title) {
    return `<div class="liq-section-heading">${escapeHtml(title)}</div>`;
  }

  function classifySandwichStrength(ratio) {
    if (!Number.isFinite(ratio)) return "n/a";
    if (ratio >= 0.75) return "STRONG";
    if (ratio >= 0.45) return "MODERATE";
    if (ratio > 0) return "WEAK";
    return "NONE";
  }

  function classifyZoneType(continuityScore, peakConcentrationRatio) {
    if (continuityScore > 0.7 && peakConcentrationRatio < 0.35) return "CONTINUOUS STACK";
    if (continuityScore <= 0.4) return "FRAGMENTED";
    if (peakConcentrationRatio >= 0.5) return "SINGLE MAGNET";
    return "LAYERED STACK";
  }

  function classifyCascadeProbability(densityScore, continuityScore) {
    if (densityScore >= 5000000 && continuityScore >= 0.7) return "HIGH";
    if (densityScore >= 2000000 && continuityScore >= 0.5) return "MODERATE";
    return "LOW";
  }

  function classifyStructureQuality(continuityPercent, fragmentationIndex, peakConcentrationRatio) {
    if (continuityPercent >= 75 && fragmentationIndex <= 20 && peakConcentrationRatio <= 0.20) return "STRONG";
    if (continuityPercent >= 50 && fragmentationIndex <= 40 && peakConcentrationRatio <= 0.40) return "MODERATE";
    return "WEAK";
  }

  function classifyRegionBias(regionPullScore, oppositePullScore) {
    if (!Number.isFinite(regionPullScore)) return "n/a";
    if (!Number.isFinite(oppositePullScore) || oppositePullScore <= 0) return "UNOPPOSED";

    const ratio = regionPullScore / oppositePullScore;
    if (ratio >= 1.5) return "STRONG";
    if (ratio >= 1.1) return "MODERATE";
    if (ratio >= 0.9) return "BALANCED";
    return "WEAK";
  }

  function getRenderedLadder() {
    const geometry = buildRowGeometry();
    return geometry?.ladder || [];
  }

  function ensureSelectionOverlay(index) {
    let overlay = document.getElementById(`liq-selection-overlay-${index}`);
    const style = SELECTION_STYLES[index] || SELECTION_STYLES[0];

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = `liq-selection-overlay-${index}`;

      Object.assign(overlay.style, {
        position: "absolute",
        pointerEvents: "none",
        display: "none",
        boxSizing: "border-box",
        zIndex: "3"
      });
    }

    Object.assign(overlay.style, {
      borderTop: `2px solid ${style.border}`,
      borderBottom: `2px solid ${style.border}`,
      background: style.background,
      boxShadow: style.inset
    });

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

  function clearSelectionHighlights() {
    SELECTION_STYLES.forEach((_, index) => {
      const overlay = document.getElementById(`liq-selection-overlay-${index}`);
      if (overlay) overlay.style.display = "none";
    });
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
        boxShadow: "0 0 0 1px rgba(0,0,0,0.18) inset",
        zIndex: "2"
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

    counter.textContent = `${rowCount} row${rowCount === 1 ? "" : "s"}`;
    Object.assign(counter.style, {
      display: "block",
      left: "50%",
      top: "14px",
      minWidth: "140px",
      textAlign: "center",
      transform: "translateX(-50%)"
    });
  }

  function drawSelectionHighlight(geometry, range, index) {
    const overlay = ensureSelectionOverlay(index);
    if (!overlay) return;

    const topRow = geometry.rows.find(row => row.rowIndex === range.topIndex);
    const bottomRow = geometry.rows.find(row => row.rowIndex === range.bottomIndex);
    if (!topRow || !bottomRow) {
      overlay.style.display = "none";
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

  function clearRegionPanels() {
    [0, 1].forEach(index => {
      const box = document.getElementById(`liq-region-panel-${index}`);
      if (box) box.remove();
    });
  }

  function closeRegionOverlay(index) {
    savedSelections.splice(index, 1);
    renderSavedSelections();
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

    const nearestAbove = above[0];
    const nearestBelow = below[0];
    const totalAbove = above.reduce((s, c) => s + c.liquidity, 0);
    const totalBelow = below.reduce((s, c) => s + c.liquidity, 0);
    const nearestAboveDistancePercent = nearestAbove ? Number(formatPercentDistance(nearestAbove.price, price)) : NaN;
    const nearestBelowDistancePercent = nearestBelow ? Number(formatPercentDistance(nearestBelow.price, price)) : NaN;
    const weightedPullAbove = safeDivide(totalAbove, nearestAboveDistancePercent) / 1000000;
    const weightedPullBelow = safeDivide(totalBelow, nearestBelowDistancePercent) / 1000000;
    const dominanceScore = normalizeDirectionalScore(totalAbove, totalBelow);
    const pullScore = normalizeDirectionalScore(weightedPullAbove, weightedPullBelow);
    const sandwichThreshold = 5000000;
    const sandwich = (Number(nearestAbove?.liquidity) || 0) > sandwichThreshold && (Number(nearestBelow?.liquidity) || 0) > sandwichThreshold;
    const sandwichStrengthRatio = safeDivide(
      Math.min(Number(nearestAbove?.liquidity) || 0, Number(nearestBelow?.liquidity) || 0),
      Math.max(Number(nearestAbove?.liquidity) || 0, Number(nearestBelow?.liquidity) || 0)
    );

    return {
      currentPrice: price,
      currentPriceRowIndex,
      nearestAbove,
      nearestBelow,
      totalAbove,
      totalBelow,
      biasRowsChecked,
      dominanceScore,
      dominanceLabel: classifyDirectionalShort(dominanceScore),
      nearestAboveDistancePercent,
      nearestBelowDistancePercent,
      pullScore,
      pullLabel: classifyDirectionalShort(pullScore),
      sandwich,
      sandwichStrength: sandwich ? classifySandwichStrength(sandwichStrengthRatio) : "NONE",
      weightedPullAbove,
      weightedPullBelow
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

    const largestCluster = selected.reduce((largest, cluster) => {
      if (!largest || (Number(cluster.liquidity) || 0) > (Number(largest.liquidity) || 0)) return cluster;
      return largest;
    }, null);

    const avgClusterSize = selected.length > 0 ? selectedLiquidity / selected.length : 0;
    const densityScore = selectedRowCount > 0 ? selectedLiquidity / selectedRowCount : 0;
    const continuityScore = selectedRowCount > 0 ? selected.length / selectedRowCount : 0;
    const peakConcentrationRatio = selectedLiquidity > 0 && largestCluster
      ? (Number(largestCluster.liquidity) || 0) / selectedLiquidity
      : 0;
    const largestClusterDistance = largestCluster ? {
      rows: Math.abs(largestCluster.priceIndex - currentPriceRowIndex),
      percent: Number(formatPercentDistance(largestCluster.price, currentPrice))
    } : null;
    const topPrice = normalizePriceValue(ladder[maxIndex]) || 0;
    const bottomPrice = normalizePriceValue(ladder[minIndex]) || 0;
    const distanceEdgePrice = currentPrice < bottomPrice ? bottomPrice : currentPrice > topPrice ? topPrice : currentPrice;
    const distancePercent = Number(formatPercentDistance(distanceEdgePrice, currentPrice));
    const rowSpanWidth = Math.abs(topPrice - bottomPrice);
    const liquidityPerPercentMove = safeDivide(selectedLiquidity, distancePercent);
    const regionPullScore = safeDivide(selectedLiquidity, distancePercent) / 1000000;
    const regionMagnetStrength = largestCluster
      ? safeDivide(Number(largestCluster.liquidity) || 0, largestClusterDistance?.percent || 0) / 1000000
      : NaN;
    const fragmentationIndex = (1 - continuityScore) * 100;
    const continuityPercent = continuityScore * 100;
    const zoneType = classifyZoneType(continuityScore, peakConcentrationRatio);
    const cascadeProbability = classifyCascadeProbability(densityScore, continuityScore);
    const structureQuality = classifyStructureQuality(continuityPercent, fragmentationIndex, peakConcentrationRatio);

    return {
      clusterCount: selectedRowCount,
      activeClusterCount: selected.length,
      totalLiquidity: selectedLiquidity,
      currentPrice,
      currentPriceRowIndex,
      avgClusterSize,
      largestCluster,
      largestClusterDistance,
      densityScore,
      continuityScore,
      peakConcentrationRatio,
      rowSpanWidth,
      liquidityPerPercentMove,
      regionPullScore,
      regionMagnetStrength,
      distance: {
        priceDistance: Math.abs(distanceEdgePrice - currentPrice),
        percent: distancePercent
      },
      continuityPercent,
      fragmentationIndex,
      structureQuality,
      zoneType,
      cascadeProbability
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
      const styleTag = document.createElement("style");
      styleTag.id = "liq-tools-panel-style";
      styleTag.textContent = `
        #liq-tools-panel, [id^="liq-region-panel-"] {
          position: fixed;
          width: 320px;
          z-index: 999999;
          background: #111;
          color: #fff;
          border: 1px solid #fff;
          border-radius: 10px;
          font-family: monospace;
          font-size: 13px;
          line-height: 1.45;
          box-sizing: border-box;
          overflow: hidden;
        }
        #liq-tools-panel {
          left: 10px;
          bottom: 10px;
        }
        [id^="liq-region-panel-"] {
          top: 10px;
        }
        #liq-tools-panel .liq-panel-header, [id^="liq-region-panel-"] .liq-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255,255,255,0.12);
        }
        #liq-tools-panel .liq-panel-title, [id^="liq-region-panel-"] .liq-panel-title {
          font-size: 16px;
          font-weight: 700;
        }
        #liq-tools-panel .liq-panel-toggle, [id^="liq-region-panel-"] .liq-panel-toggle {
          background: #1b1b1b;
          color: #fff;
          border: 1px solid #fff;
          border-radius: 6px;
          padding: 0 8px 2px;
          font: inherit;
          cursor: pointer;
        }
        #liq-tools-panel .liq-panel-content, [id^="liq-region-panel-"] .liq-panel-content {
          padding: 14px;
          max-height: calc(100vh - 90px);
          overflow-y: auto;
          opacity: 1;
          transform: translateY(0);
          transition: max-height 180ms ease, opacity 180ms ease, transform 180ms ease, padding 180ms ease;
        }
        #liq-tools-panel.is-collapsed .liq-panel-content {
          max-height: 0;
          opacity: 0;
          transform: translateY(10px);
          padding-top: 0;
          padding-bottom: 0;
          overflow: hidden;
        }
        #liq-tools-panel.is-collapsed .liq-panel-header {
          border-bottom: none;
        }
        #liq-tools-panel .liq-section-heading, [id^="liq-region-panel-"] .liq-section-heading {
          margin: 0 0 8px;
          font-size: 14px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        #liq-tools-panel .liq-section-heading:not(:first-child), [id^="liq-region-panel-"] .liq-section-heading:not(:first-child) {
          margin-top: 16px;
        }
        #liq-tools-panel .liq-stat-row, [id^="liq-region-panel-"] .liq-stat-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: baseline;
          gap: 16px;
          margin: 4px 0;
        }
        #liq-tools-panel .liq-stat-label, [id^="liq-region-panel-"] .liq-stat-label {
          text-align: left;
          white-space: nowrap;
        }
        #liq-tools-panel .liq-stat-value, [id^="liq-region-panel-"] .liq-stat-value {
          text-align: right;
          white-space: nowrap;
        }
        #liq-tools-panel .liq-info-tip, [id^="liq-region-panel-"] .liq-info-tip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          margin-left: 4px;
          border: 1px solid rgba(255,255,255,0.6);
          border-radius: 999px;
          font-size: 10px;
          line-height: 1;
          cursor: help;
          color: rgba(255,255,255,0.9);
        }
      `;
      document.head.appendChild(styleTag);

      panel = document.createElement("div");
      panel.id = "liq-tools-panel";
      panel.innerHTML = `
        <div class="liq-panel-header">
          <div class="liq-panel-title">Heatmap Overview</div>
          <button type="button" class="liq-panel-toggle" aria-expanded="true">-</button>
        </div>
        <div class="liq-panel-content"></div>
      `;

      const toggle = panel.querySelector(".liq-panel-toggle");
      toggle.addEventListener("click", () => {
        overlayCollapsed = !overlayCollapsed;
        panel.classList.toggle("is-collapsed", overlayCollapsed);
        toggle.textContent = overlayCollapsed ? "+" : "-";
        toggle.setAttribute("aria-expanded", overlayCollapsed ? "false" : "true");
      });

      document.body.appendChild(panel);
    }

    panel.classList.toggle("is-collapsed", overlayCollapsed);
    const toggle = panel.querySelector(".liq-panel-toggle");
    if (toggle) {
      toggle.textContent = overlayCollapsed ? "+" : "-";
      toggle.setAttribute("aria-expanded", overlayCollapsed ? "false" : "true");
    }

    return panel;
  }

  function ensureRegionPanel(index) {
    let box = document.getElementById(`liq-region-panel-${index}`);
    const style = SELECTION_STYLES[index] || SELECTION_STYLES[0];

    if (!box) {
      box = document.createElement("div");
      box.id = `liq-region-panel-${index}`;
      document.body.appendChild(box);
    }

    const left = 10 + (index * 330);

    Object.assign(box.style, {
      position: "fixed",
      left: `${left}px`,
      top: "10px",
      width: "320px",
      zIndex: 999999,
      background: "#111",
      color: "#fff",
      border: `1px solid ${style.panelBorder}`,
      borderRadius: "10px",
      fontFamily: "monospace",
      fontSize: "13px",
      lineHeight: "1.45",
      maxHeight: "calc(100vh - 20px)",
      overflow: "hidden",
      boxSizing: "border-box"
    });

    return box;
  }

  function renderOverlay(stats) {
    const panel = ensureOverlayPanel();
    const content = panel.querySelector(".liq-panel-content");
    const dominanceDisplay = `${formatSignedMetric(stats.dominanceScore)} (${stats.dominanceLabel})`;
    const pullDisplay = `${formatSignedMetric(stats.pullScore)} (${stats.pullLabel})`;
    const sandwichRow = stats.sandwich
      ? renderStatRow("Sandwich", escapeHtml(stats.sandwichStrength), "WEAK | MODERATE | STRONG")
      : "";
    drawCurrentPriceHighlight(stats.currentPrice);

    content.innerHTML = `
      ${renderStatRow("Price", escapeHtml(formatCurrency(stats.currentPrice)))}
      ${renderSectionHeading("Directional Bias")}
      ${sandwichRow}
      ${renderStatRow("Pull Score", escapeHtml(pullDisplay), "UP | DOWN | FLAT")}
      ${renderStatRow("Dominance", escapeHtml(dominanceDisplay), "UP | DOWN | FLAT")}
      ${renderSectionHeading("Nearest Magnets")}
      ${renderStatRow("Above", escapeHtml(formatPriceWithDistance(stats.nearestAbove?.price, stats.currentPrice)))}
      ${renderStatRow("Below", escapeHtml(formatPriceWithDistance(stats.nearestBelow?.price, stats.currentPrice)))}
      ${renderSectionHeading("Range Liquidity")}
      ${renderStatRow("Total Above", escapeHtml(formatCurrency(stats.totalAbove)))}
      ${renderStatRow("Total Below", escapeHtml(formatCurrency(stats.totalBelow)))}
    `;
  }

  /* ---------- region panel ---------- */

  function renderRegionOverlay(index, selectionData) {
    const box = ensureRegionPanel(index);
    const { stats } = selectionData;
    const distancePrice = Number(stats.distance?.priceDistance);
    const distancePercent = Number(stats.distance?.percent);
    const continuityPercent = Number.isFinite(Number(stats.continuityPercent))
      ? Number(stats.continuityPercent)
      : Number(stats.continuityScore) * 100;
    const fragmentationIndex = Number(stats.fragmentationIndex);
    const distanceDisplay = Number.isFinite(distancePrice) && Number.isFinite(distancePercent)
      ? `${formatCurrency(distancePrice)} (${distancePercent.toFixed(2)}%)`
      : "n/a";

    box.innerHTML = `
      <div class="liq-panel-header">
        <div class="liq-panel-title">Selected Region ${index + 1}</div>
        <button id="liq-region-close-${index}" type="button" class="liq-panel-toggle">x</button>
      </div>
      <div class="liq-panel-content">
        ${renderStatRow("Distance", escapeHtml(distanceDisplay))}
        ${renderSectionHeading("Liquidity Mass")}
        ${renderStatRow("Total Liquidity", escapeHtml(formatCurrency(stats.totalLiquidity)))}
        ${renderStatRow("Cluster Count", escapeHtml(String(stats.activeClusterCount)))}
        ${renderSectionHeading("Structure Quality")}
        ${renderStatRow("Continuity Score", escapeHtml(Number.isFinite(continuityPercent) ? `${continuityPercent.toFixed(2)}%` : "n/a"))}
        ${renderStatRow("Fragmentation Index", escapeHtml(Number.isFinite(fragmentationIndex) ? `${fragmentationIndex.toFixed(2)}%` : "n/a"))}
        ${renderStatRow("Peak Concentration Ratio", escapeHtml(formatRatio(stats.peakConcentrationRatio)))}
        ${renderStatRow("Structure Quality", escapeHtml(stats.structureQuality), "STRONG | MODERATE | WEAK")}
        <br>
        ${renderStatRow("Zone Type", escapeHtml(stats.zoneType), "CONTINUOUS STACK | LAYERED STACK | FRAGMENTED | SINGLE MAGNET")}
        ${renderStatRow("Cascade Probability", escapeHtml(stats.cascadeProbability), "LOW | MODERATE | HIGH")}
      </div>
    `;

    const closeButton = document.getElementById(`liq-region-close-${index}`);
    if (closeButton) {
      closeButton.onclick = () => closeRegionOverlay(index);
    }
  }

  function renderSavedSelections() {
    clearSelectionHighlights();
    clearRegionPanels();

    savedSelections = savedSelections.map(selectionData => {
      const refreshedStats = computeRegionStats(selectionData.range.minIndex, selectionData.range.maxIndex);
      return refreshedStats ? { ...selectionData, stats: refreshedStats } : selectionData;
    });

    const geometry = buildRowGeometry();
    savedSelections.forEach((selectionData, index) => {
      if (geometry) {
        drawSelectionHighlight(geometry, selectionData.range, index);
      }
      renderRegionOverlay(index, selectionData);
    });
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

    const nextSelection = {
      range,
      topPrice,
      bottomPrice,
      stats
    };

    if (savedSelections.length === 0) {
      savedSelections = [nextSelection];
    } else if (savedSelections.length === 1) {
      savedSelections = [savedSelections[0], nextSelection];
    } else {
      savedSelections = [savedSelections[0], nextSelection];
    }

    renderSavedSelections();
  }

  setTimeout(installDragSelection, 3000);
})();
