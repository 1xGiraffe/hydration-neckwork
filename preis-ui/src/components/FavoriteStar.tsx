export default function FavoriteStar({ selected }: { selected: boolean }) {
  return selected
    ? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z" /></svg>
    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z" /></svg>
}
