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

  console.log("Heatmap watcher booting... category-axis resolver enabled 1");

  /* -------------------------------------------------
     FOUNDATION 1 — DATA EXTRACTION (unchanged)
  ------------------------------------------------- */

  let lastUpdateTime = null;

  function findHeatmapData() {

    const rootEl = document.querySelector("#__next");
    if (!rootEl) return null;

    const reactKey =
      Object.keys(rootEl)
        .find(k => k.startsWith("__reactContainer$"));

    if (!reactKey) return null;

    const fiberRoot = rootEl[reactKey];
    let found = null;

    function scan(node) {

      if (!node || found) return;

      try {

        const buckets =
          [
            node.memoizedState,
            node.memoizedProps,
            node.stateNode?.state
          ].filter(Boolean);

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

    window.__liqClusters =
      data.liq.map(([t, p, v]) => ({

        timeIndex: t,
        priceIndex: p,
        price: data.y[p],
        liquidity: v
      }));

    renderOverlay(
      computeNearestClusters(data, window.__liqClusters)
    );

    console.log(
      "Heatmap dataset updated:",
      __liqClusters.length,
      "clusters"
    );
  }

  setInterval(updateDataset, 1500);

  /* -------------------------------------------------
     FOUNDATION 2 — FIND ECHARTS INSTANCE
  ------------------------------------------------- */

  function getHeatmapInstance() {

    if (window.__heatmapInst) return window.__heatmapInst;

    const wrapper =
      document.querySelector(".echarts-for-react");

    if (!wrapper) return null;

    const fiberKey =
      Object.keys(wrapper)
        .find(k => k.startsWith("__reactFiber$"));

    if (!fiberKey) return null;

    let fiber = wrapper[fiberKey];

    for (let i = 0; i < 8 && fiber; i++) {

      if (
        fiber.tag === 1 &&
        fiber.stateNode &&
        fiber.memoizedProps?.option
      ) {

        try {

          const inst =
            fiber.stateNode.getEchartsInstance();

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

  function buildRowResolver() {

    const inst = getHeatmapInstance();
    if (!inst) return null;

    const option = inst.getOption();

    const categoryAxis =
      option.yAxis.find(a => a.type === "category");

    if (!categoryAxis) return null;

    const ladder = categoryAxis.data;

    return function clientYToRow(clientY) {

      const rect =
        inst.getDom().getBoundingClientRect();

      const localY =
        clientY - rect.top;

      let result;

      try {

        result =
          inst.convertFromPixel(
            { seriesIndex: 0 },
            [0, localY]
          );

      } catch {

        return null;
      }

      if (!result) return null;

      const rowIndex =
        Math.round(result[1]);

      if (
        rowIndex < 0 ||
        rowIndex >= ladder.length
      )
        return null;

      return {
        rowIndex,
        price: ladder[rowIndex]
      };
    };
  }

  /* -------------------------------------------------
     ANALYTICS LAYER
  ------------------------------------------------- */

  function getCurrentPrice(data) {

    const last =
      data.prices[data.prices.length - 1];

    return Number(last[4]);
  }

  function computeNearestClusters(data, clusters) {

    const price =
      getCurrentPrice(data);

    const latest =
      data.prices.length - 1;

    const rows =
      clusters.filter(c => c.timeIndex === latest);

    const above =
      rows.filter(c => c.price > price);

    const below =
      rows.filter(c => c.price < price);

    above.sort((a, b) => a.price - b.price);
    below.sort((a, b) => b.price - a.price);

    return {

      currentPrice: price,
      nearestAbove: above[0],
      nearestBelow: below[0],
      totalAbove:
        above.reduce((s, c) => s + c.liquidity, 0),
      totalBelow:
        below.reduce((s, c) => s + c.liquidity, 0)
    };
  }

  function computeRegionStats(minIndex, maxIndex) {

    const data =
      window.__liqHeatmapData;

    if (!data) return null;

    const latest =
      data.prices.length - 1;

    const clusters =
      window.__liqClusters
        .filter(c => c.timeIndex === latest);

    const selected =
      clusters.filter(c =>

        c.priceIndex >= minIndex &&
        c.priceIndex <= maxIndex
      );

    return {

      clusterCount: selected.length,

      totalLiquidity:
        selected.reduce((s, c) =>
          s + c.liquidity, 0)
    };
  }

  /* -------------------------------------------------
     UI LAYER
  ------------------------------------------------- */

  let resolver = null;

  function ensureResolverReady() {

    if (!resolver) {

      resolver =
        buildRowResolver();
    }

    return resolver;
  }

  /* ---------- main tools panel ---------- */

  function ensureOverlayPanel() {

    let panel =
      document.getElementById(
        "liq-tools-panel"
      );

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
        fontSize: "13px"
      });

      document.body.appendChild(panel);
    }

    return panel;
  }

  function renderOverlay(stats) {

    const panel =
      ensureOverlayPanel();

    const bias =
      stats.totalAbove > stats.totalBelow
        ? "UPWARD" : "DOWNWARD";

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

    let box =
      document.getElementById(
        "liq-region-panel"
      );

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

    box.innerHTML = `

<b>Selected Region</b><br><br>

Top: ${max.toFixed(2)}<br>
Bottom: ${min.toFixed(2)}<br><br>

Clusters: ${stats.clusterCount}<br>
Liquidity: $${Math.round(stats.totalLiquidity).toLocaleString()}

`;
  }

  /* -------------------------------------------------
     DRAG SELECTION (FIXED VERSION)
  ------------------------------------------------- */

  let selection = { active: false, startY: null, endY: null };

  function installDragSelection() {

    const container =
      getHeatmapInstance()?.getDom();

    if (!container) return;

    container.addEventListener("mousedown", e => {

      selection.active = true;
      selection.startY = e.clientY;
    });

    window.addEventListener("mouseup", e => {

      if (!selection.active) return;

      selection.active = false;
      selection.endY = e.clientY;

      handleSelection();
    });
  }

  function handleSelection() {

    const resolve =
      ensureResolverReady();

    if (!resolve) return;

    const a =
      resolve(selection.startY);

    const b =
      resolve(selection.endY);

    if (!a || !b) return;

    const minIndex =
      Math.min(a.rowIndex, b.rowIndex);

    const maxIndex =
      Math.max(a.rowIndex, b.rowIndex);

    const minPrice =
      Math.min(a.price, b.price);

    const maxPrice =
      Math.max(a.price, b.price);

    const stats =
      computeRegionStats(
        minIndex,
        maxIndex
      );

    renderRegionOverlay(
      minPrice,
      maxPrice,
      stats
    );
  }

  setTimeout(installDragSelection, 3000);

})();