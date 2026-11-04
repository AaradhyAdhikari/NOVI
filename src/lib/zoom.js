// Pinching and moving a full-screen picture. A view is { zoom, x, y }: x and y are how far the picture's
// centre has moved. Finger spots are measured from the middle of the screen.
const MAX_ZOOM = 5;
const FLAT = { zoom: 1, x: 0, y: 0 };

const inside = ({ zoom, x, y }, { w, h }) => {
  const maxX = (w * (zoom - 1)) / 2;
  const maxY = (h * (zoom - 1)) / 2;
  return { zoom, x: Math.max(-maxX, Math.min(maxX, x)) + 0, y: Math.max(-maxY, Math.min(maxY, y)) + 0 };
};

// start = { view, gap, mid } when the second finger came down; gap and mid are where the fingers are now.
export function pinchView(start, gap, mid, size) {
  const zoom = Math.max(1, Math.min(MAX_ZOOM, start.view.zoom * (gap / start.gap)));
  if (zoom === 1) return FLAT;
  const ratio = zoom / start.view.zoom;
  return inside({ zoom, x: mid.x - (start.mid.x - start.view.x) * ratio, y: mid.y - (start.mid.y - start.view.y) * ratio }, size);
}

export const panView = (view, dx, dy, size) => inside({ zoom: view.zoom, x: view.x + dx, y: view.y + dy }, size);

export function tapResult(view, double) {
  if (double) return view.zoom > 1 ? 'reset' : 'zoom';
  return view.zoom > 1 ? 'none' : 'close';
}
