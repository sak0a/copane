// A wrapper that renders its children: it is the button's parent, not the component that wrote it.
export default function Layout({ title, children }) {
  return (
    <section className="layout">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
