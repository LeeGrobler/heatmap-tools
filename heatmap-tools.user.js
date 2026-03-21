// ==UserScript==
// @name         Coinglass Heatmap Tools (Dev Build)
// @namespace    coinglass-heatmap-tools
// @version      0.2
// @description  Adds analytical tooling to Coinglass liquidation heatmap
// @match        https://www.coinglass.com/*
// @match        https://coinglass.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    file:///C:/Users/Lee/Documents/Projects/coinglass-tools/heatmap-tools.user.js
// @downloadURL  file:///C:/Users/Lee/Documents/Projects/coinglass-tools/heatmap-tools.user.js
// ==/UserScript==

(function installHeatmapWatcher() {
  // FOUNDATION

  console.log("Heatmap watcher booting...");

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
      } catch (e) { }

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

    window.__liqClusters = data.liq.map(([t, p, v]) => ({
      timeIndex: t,
      priceIndex: p,
      price: data.y[p],
      liquidity: v
    }));

    renderOverlay(computeNearestClusters(data, window.__liqClusters));
    console.log("Heatmap dataset updated:", __liqClusters.length, "clusters");
  }

  setInterval(updateDataset, 1500);

  // ANALYTICS LAYER

  function getCurrentPrice(data) {
    const lastCandle = data.prices[data.prices.length - 1];
    return Number(lastCandle[4]);
  }

  function screenYToPrice(y) {
    const data = window.__liqHeatmapData;
    if (!data) return null;

    const chart = document.querySelector("[data-zr-dom-id]");
    if (!chart) return null;

    const rect = chart.getBoundingClientRect();
    const relativeY = y - rect.top;
    const ratio = relativeY / rect.height;
    const priceIndex = Math.round(ratio * (data.y.length - 1));

    return data.y[priceIndex];
  }

  function computeNearestClusters(data, clusters) {
    const price = getCurrentPrice(data);
    const latestTimeIndex = data.prices.length - 1;
    const latestClusters = clusters.filter(c => c.timeIndex === latestTimeIndex);
    const above = latestClusters.filter(c => c.price > price);
    const below = latestClusters.filter(c => c.price < price);

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

  function computeRegionStats(minPrice, maxPrice) {
    const clusters = window.__liqClusters;
    if (!clusters) return null;

    const selected = clusters.filter(c => c.price >= minPrice && c.price <= maxPrice);
    const totalLiquidity = selected.reduce((sum, c) => sum + c.liquidity, 0);

    return {
      clusterCount: selected.length,
      totalLiquidity
    };
  }

  // UI LAYER

  let selection = {
    active: false,
    startY: null,
    endY: null
  };

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
        borderRadius: "10px",
        fontFamily: "monospace",
        fontSize: "13px",
        boxShadow: "0 0 12px rgba(0,0,0,.6)"
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

  function renderRegionOverlay(minPrice, maxPrice, stats) {
    let box = document.getElementById("liq-region-panel");

    if (!box) {
      box = document.createElement("div");
      box.id = "liq-region-panel";

      Object.assign(box.style, {
        position: "fixed",
        left: "20px",
        top: "120px",
        zIndex: 999999,
        background: "#111",
        color: "#fff",
        padding: "14px",
        borderRadius: "10px",
        fontFamily: "monospace"
      });

      document.body.appendChild(box);
    }

    const currentPrice = getCurrentPrice(window.__liqHeatmapData);

    box.innerHTML = `
      <b>Selected Region</b><br><br>
      Top: ${maxPrice.toFixed(2)}<br>
      Bottom: ${minPrice.toFixed(2)}<br><br>
      Clusters: ${stats.clusterCount}<br>
      Liquidity: $${Math.round(stats.totalLiquidity).toLocaleString()}<br><br>
      Distance from price: ${(((maxPrice + minPrice) / 2) - currentPrice).toFixed(2)}
    `;

  }

  function installDragSelection() {
    const container = document.querySelector("[data-zr-dom-id]")?.parentElement;

    if (!container) {
      console.log("Heatmap container not found");
      return;
    }

    console.log("Using heatmap container:", container);

    container.addEventListener("mousedown", e => {
      selection.active = true;
      selection.startY = e.clientY;
      console.log("Drag start:", selection.startY);
    });

    window.addEventListener("mouseup", e => {
      if (!selection.active) return;

      selection.active = false;
      selection.endY = e.clientY;

      console.log("Drag end:", selection.endY);
      handleSelection();
    });
  }

  function handleSelection() {
    const priceA = screenYToPrice(selection.startY);
    const priceB = screenYToPrice(selection.endY);
    if (!priceA || !priceB) return;

    const minPrice = Math.min(priceA, priceB);
    const maxPrice = Math.max(priceA, priceB);
    const stats = computeRegionStats(minPrice, maxPrice);

    renderRegionOverlay(minPrice, maxPrice, stats);
  }

  setTimeout(installDragSelection, 3000);
})();