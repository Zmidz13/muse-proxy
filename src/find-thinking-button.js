const { chromium } = require('playwright');

(async () => {
  const userDataDir = path.join(os.homedir(), '.pw-brave-profile');
  const browser = await chromium.launchPersistentContext(userDataDir, {
    executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    headless: false,
    args: ['--profile-directory=Default']
  });

  const page = await browser.pages()[0] || await browser.newPage();
  
  console.log('Navegando para o Meta AI...');
  await page.goto('https://www.meta.ai/', { waitUntil: 'domcontentloaded' });
  
  console.log('A aguardar 5 segundos para login e carregamento...');
  await page.waitForTimeout(5000);

  // Inject script to detect thinking button
  const thinkingInfo = await page.evaluate(() => {
    // Check for stop button
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const stopButtons = buttons.filter(btn => {
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const txt = (btn.innerText || '').toLowerCase().trim();
      return aria.includes('stop') || aria.includes('parar') || txt.includes('stop') || txt.includes('parar');
    });

    // Check for thinking/reasoning related elements
    const thinkingElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = (el.innerText || el.textContent || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const classes = Array.from(el.classList || []).join(' ').toLowerCase();
      return (
        (text.includes('thinking') || text.includes('reasoning') || text.includes('deep research') || text.includes('pesquisa')) &&
        el.children.length < 5
      );
    });

    // Check for any data-testid related to thinking
    const testIdElements = Array.from(document.querySelectorAll('[data-testid*="think"], [data-testid*="reason"], [data-testid*="spark"]'));

    // Look for toggle buttons near input
    const inputArea = document.querySelector('[data-lexical-editor="true"]');
    const nearInput = inputArea ? inputArea.closest('form, div') : null;
    const formButtons = nearInput ? Array.from(nearInput.querySelectorAll('button, [role="button"]')) : [];

    return {
      stopButtons: stopButtons.map(b => ({
        text: b.innerText?.trim()?.slice(0, 50),
        ariaLabel: b.getAttribute('aria-label'),
        className: b.className,
        id: b.id,
        dataTestId: b.getAttribute('data-testid')
      })),
      thinkingElements: thinkingElements.slice(0, 5).map(e => ({
        tag: e.tagName,
        text: (e.innerText || '').slice(0, 100),
        ariaLabel: e.getAttribute('aria-label'),
        className: e.className,
        id: e.id,
        dataTestId: e.getAttribute('data-testid')
      })),
      testIdElements: testIdElements.map(e => ({
        tag: e.tagName,
        text: (e.innerText || '').slice(0, 50),
        dataTestId: e.getAttribute('data-testid')
      })),
      formButtons: formButtons.map(b => ({
        text: b.innerText?.trim()?.slice(0, 50),
        ariaLabel: b.getAttribute('aria-label'),
        className: b.className,
        dataTestId: b.getAttribute('data-testid')
      }))
    };
  });

  console.log('\n=== STOP BUTTONS ===');
  console.log(JSON.stringify(thinkingInfo.stopButtons, null, 2));
  
  console.log('\n=== THINKING ELEMENTS ===');
  console.log(JSON.stringify(thinkingInfo.thinkingElements, null, 2));
  
  console.log('\n=== TESTID ELEMENTS ===');
  console.log(JSON.stringify(thinkingInfo.testIdElements, null, 2));
  
  console.log('\n=== FORM BUTTONS (near input) ===');
  console.log(JSON.stringify(thinkingInfo.formButtons, null, 2));

  console.log('\nAguardar para inspeção manual (30s)...');
  await page.waitForTimeout(30000);

  await browser.close();
})();
