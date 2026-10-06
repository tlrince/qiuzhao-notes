/** The app mark: same artwork as the Dock icon (src-tauri/icons/source.svg), cropped to the tile. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="brand-mark-bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#2cc6b0" /><stop offset="0.55" stopColor="#14998a" /><stop offset="1" stopColor="#0b6a62" />
      </linearGradient>
      <linearGradient id="brand-mark-leaf" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="#fffdf6" /><stop offset="1" stopColor="#e3f6f1" />
      </linearGradient>
    </defs>
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#brand-mark-bg)" />
    <path d="M326 708C268 476 424 304 740 288C754 566 594 738 326 708Z" fill="url(#brand-mark-leaf)" />
    <path d="M282 770Q300 738 330 704" stroke="#fffdf6" strokeWidth="24" strokeLinecap="round" fill="none" />
    <g stroke="#0f766e" strokeLinecap="round" fill="none" opacity="0.4">
      <path d="M332 702Q500 540 700 322" strokeWidth="14" />
      <path d="M430 600Q404 548 404 482M520 508Q500 460 506 400M604 418Q592 384 600 346M430 600Q490 618 552 610M520 508Q578 520 636 512M604 418Q646 424 684 414" strokeWidth="10" />
    </g>
  </svg>;
}
