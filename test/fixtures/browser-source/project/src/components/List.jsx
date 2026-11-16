import Card from './Card.jsx';

export default function List({ items }) {
  return (
    <ul>
      {items.map(item => (
        <li key={item}>
          <Card title={item} />
        </li>
      ))}
    </ul>
  );
}
