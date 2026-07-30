/**
 * Reusable dismissal hook for popovers/dropdowns editor-wide: closes on a
 * click outside the element (ignoring its own trigger), on Escape, and on
 * window resize. Any dropdown/popover component can wire itself up with the
 * same 3 listeners without duplicating this logic.
 *
 * @param {object} options
 * @param {() => (HTMLElement|null)} options.getElement - Returns the currently open dismissable element, or null/undefined if none is open.
 * @param {(target: EventTarget) => boolean} options.isTrigger - Returns true if the given event target is (or is inside) the trigger that opened the element, so its own click doesn't immediately re-dismiss it.
 * @param {() => void} options.onDismiss - Called to dismiss/close the element.
 */
export function registerDismissable({ getElement, isTrigger, onDismiss }) {
  document.addEventListener('click', (e) => {
    const element = getElement();
    if (!element || element.hidden) return;
    if (element.contains(e.target)) return;
    if (isTrigger && isTrigger(e.target)) return;
    onDismiss();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const element = getElement();
    if (element && !element.hidden) onDismiss();
  });

  window.addEventListener('resize', () => {
    const element = getElement();
    if (element && !element.hidden) onDismiss();
  });
}
