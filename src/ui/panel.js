const panelCss = require('./panel.css');
const panelHtml = require('./panel.html');

const SCRIPT_NAME_PLACEHOLDER = '__SCRIPT_NAME__';

function buildPanelTemplate(scriptName) {
  const html = panelHtml.split(SCRIPT_NAME_PLACEHOLDER).join(String(scriptName || ''));
  return `<style>${panelCss}</style>${html}`;
}

module.exports = { buildPanelTemplate };
