// Runs in the report page. The page is complete without it; this adds filtering the
// case list by any count in the report, and opening or closing every case at once.
{
  const cases = [...document.querySelectorAll("details.case")];
  const filters = [...document.querySelectorAll("button.filter[data-cases]")];
  const statusLine = document.getElementById("filter-status");
  const toggleAll = document.getElementById("toggle-all");

  function show(caseIds, label, pressed) {
    const wanted = new Set(caseIds);
    let shown = 0;
    for (const element of cases) {
      element.hidden = !wanted.has(element.dataset.case);
      if (!element.hidden) shown += 1;
    }
    statusLine.textContent = `${label}: ${shown} of ${cases.length} cases`;
    for (const filter of filters) filter.setAttribute("aria-pressed", String(filter === pressed));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-cases]");
    if (!button) return;
    const inFilterRow = button.classList.contains("filter");
    show(JSON.parse(button.dataset.cases), button.dataset.label, inFilterRow ? button : null);
    if (!inFilterRow) document.getElementById("cases").scrollIntoView({ block: "start" });
  });

  toggleAll.addEventListener("click", () => {
    const open = toggleAll.getAttribute("aria-pressed") !== "true";
    for (const element of cases) element.open = open;
    toggleAll.setAttribute("aria-pressed", String(open));
    toggleAll.textContent = open ? "Collapse all" : "Expand all";
  });
  toggleAll.hidden = false;
}
