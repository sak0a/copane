// A hot update with a bug: render() throws at line 4.
export function render(panel) {
  const cart = undefined;
  panel.textContent = cart.price;
}
