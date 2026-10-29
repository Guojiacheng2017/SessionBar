type AppPage = "dashboard";
type ConnectionState = "connecting" | "online" | "offline";

/** Header structure belongs here, not in each page's HTML. */
export function appHeaderMarkup(activePage: AppPage): string {
  return `<a class="app-brand" href="./" aria-label="SessionBar dashboard"><img src="./sessionbar-wordmark.svg" alt="SessionBar"></a>
    <div class="app-header-actions">
      <nav class="app-nav" aria-label="Application"><a href="./"${activePage === "dashboard" ? ' aria-current="page"' : ""}>Dashboard</a></nav>
      <span id="port" class="connection-pill" role="status"></span>
    </div>`;
}

export function mountAppHeader(activePage: AppPage, initialState: ConnectionState = "online") {
  const header = document.querySelector<HTMLElement>("[data-app-header]");
  if (!header) throw new Error("Missing application header mount point");
  header.innerHTML = appHeaderMarkup(activePage);
  const port = header.querySelector<HTMLElement>("#port")!;

  function setConnectionState(state: ConnectionState): void {
    port.dataset.state = state;
    port.textContent = state === "online"
      ? (window.location.port ? `:${window.location.port}` : "local")
      : state;
  }

  setConnectionState(initialState);
  return { setConnectionState };
}
