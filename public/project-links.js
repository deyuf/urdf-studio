// Native details keeps the links available even without JavaScript.
for (const menu of document.querySelectorAll('.project-switcher')) {
  const trigger = menu.querySelector('summary');
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      event.preventDefault();
      event.stopPropagation();
      menu.open = false;
      trigger.focus();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('focusout', event => {
    if (!menu.contains(event.relatedTarget)) menu.open = false;
  });
}
