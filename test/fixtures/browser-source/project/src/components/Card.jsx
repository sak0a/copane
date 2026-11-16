import Layout from './Layout.jsx';

// A product card: the button below is what browser_inspect finds.
export default function Card({ title }) {
  return (
    <Layout title={title}>
      <button id="add">Add to cart</button>
    </Layout>
  );
}
