// Local, static search: documentation content stays on this origin.
(() => {
  const base = new URL('.', document.currentScript.src);
  const dialog = document.getElementById('docs-search');
  const input = document.getElementById('docs-search-input');
  const status = document.getElementById('docs-search-status');
  const results = document.getElementById('docs-search-results');
  let entries;
  let loading;

  function render() {
    if (!entries) return;
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = entries.filter(entry => words.every(word =>
      `${entry.title} ${entry.description} ${entry.text}`.toLowerCase().includes(word)
    ));
    results.replaceChildren();
    for (const entry of matches) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = new URL(entry.url, base).href;
      link.textContent = entry.title;
      const description = document.createElement('p');
      description.textContent = entry.description;
      item.append(link, description);
      results.append(item);
    }
    status.textContent = matches.length ? `${matches.length} results` : 'No results. Try another keyword.';
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    input.focus();
    if (!entries) {
      status.textContent = 'Loading documentation…';
      try {
        loading ||= fetch(new URL('search-index.json', base)).then(response => {
          if (!response.ok) throw new Error('Search index unavailable');
          return response.json();
        });
        entries = await loading;
      } catch {
        loading = undefined;
        status.textContent = 'Search could not load. Close and reopen to retry, or use the documentation navigation.';
        return;
      }
    }
    render();
  }

  document.getElementById('docs-search-open').addEventListener('click', open);
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.close();
    } else if (event.key === 'Enter') {
      const first = results.querySelector('a');
      if (first) first.click();
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      open();
    }
  });
})();
