// Shared by the fixture pages: where the project files are (?root=<workspace folder>), as the page's
// framework data would name them. ?win=1 writes them with backslashes, as a Windows dev server does.
(function () {
  const params = new URLSearchParams(location.search);
  const root = (params.get('root') || '/workspace').replace(/[\\/]+$/, '');
  const win = params.has('win');
  /** Absolute path of a project file (rel like "src/App.vue"). */
  window.projectPath = rel => {
    const path = `${root}/source-app/${rel}`;
    return win ? path.replace(/\//g, '\\') : path;
  };
  window.fixtureParams = params;
})();
