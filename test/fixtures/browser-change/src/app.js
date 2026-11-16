// The hot-updated module: repaints the panel for the new version.
export function render(panel, version) {
  panel.textContent = `Panel updated to version ${version}`;
  panel.style.background = `hsl(${(version * 47) % 360}, 80%, 60%)`;
}
