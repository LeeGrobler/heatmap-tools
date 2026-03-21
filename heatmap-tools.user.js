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

    window.__liqClusters =
      data.liq.map(([t, p, v]) => ({
        timeIndex: t,
        priceIndex: p,
        price: data.y[p],
        liquidity: v
      }));

    console.log(
      "Heatmap dataset updated:",
      __liqClusters.length,
      "clusters"
    );
  }

  setInterval(updateDataset, 1500);
})();