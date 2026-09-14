import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import fetchCookie from "fetch-cookie";
import iconv from "iconv-lite";
import { chromium } from "playwright-core";
import { CookieJar } from "tough-cookie";

const execFileAsync = promisify(execFile);
const AUTH_URL = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";
const PORTAL_URL = "https://portalcf.cloud.afip.gob.ar/portal/app/";
const RCEL_ORIGIN = "https://fe.afip.gob.ar";
const RCEL_BASE = `${RCEL_ORIGIN}/rcel/jsp/`;
const RCEL_MENU_URL = `${RCEL_BASE}menu_ppal.jsp`;
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const MAX_REDIRECTS = 10;

function assertDate(value, field) {
  if (!DATE_RE.test(value)) throw new Error(`${field} must use DD/MM/YYYY`);
}

function assertOfficialUrl(value) {
  const parsed = new URL(value);
  const hostname = parsed.hostname;
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to send ARCA data over non-HTTPS transport: ${parsed.protocol}`);
  }
  if (!["auth.afip.gob.ar", "portalcf.cloud.afip.gob.ar", "fe.afip.gob.ar"].includes(hostname)) {
    throw new Error(`Refusing to send ARCA data to non-official host: ${hostname}`);
  }
}

export async function fetchOfficial(fetchImpl, input, options = {}) {
  let url = new URL(input).href;
  let method = String(options.method || "GET").toUpperCase();
  let body = options.body;
  const headers = new Headers(options.headers || {});

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertOfficialUrl(url);
    const response = await fetchImpl(url, { ...options, method, headers, body, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === MAX_REDIRECTS) throw new Error(`Too many redirects while requesting ${url}`);

    const nextUrl = new URL(location, url).href;
    assertOfficialUrl(nextUrl);
    if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    url = nextUrl;
  }

  throw new Error(`Too many redirects while requesting ${url}`);
}

function parseEnv(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function safeSlug(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

function encodeLatin1Component(value) {
  const safe = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._".split(""));
  let output = "";
  for (const byte of iconv.encode(String(value), "latin1")) {
    const char = String.fromCharCode(byte);
    if (safe.has(char)) output += char;
    else if (byte === 0x20) output += "+";
    else output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return output;
}

function encodeForm(entries) {
  return entries.map(([name, value]) => `${encodeLatin1Component(name)}=${encodeLatin1Component(value ?? "")}`).join("&");
}

function decodeBody(buffer, contentType) {
  return /charset=ISO-8859-1/i.test(contentType || "") ? iconv.decode(buffer, "latin1") : buffer.toString("utf8");
}

function headerList(headers) {
  return [...headers.entries()].map(([name, value]) => ({
    name,
    value: ["cookie", "set-cookie", "authorization"].includes(name.toLowerCase()) ? "[REDACTED]" : value,
  }));
}

class HarRecorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    this.startedAt = new Date().toISOString();
  }

  async record({ startedDateTime, elapsed, method, url, requestHeaders, requestCookies, requestBody, response, responseBuffer }) {
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const textual = /^(text\/|application\/(json|javascript|xml|xhtml))/i.test(contentType);
    this.entries.push({
      pageref: "arca-direct-http",
      startedDateTime,
      time: elapsed,
      request: {
        method,
        url,
        httpVersion: "HTTP/1.1",
        headers: headerList(requestHeaders),
        queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
        cookies: requestCookies.map(cookie => ({ name: cookie.key, value: "[REDACTED]" })),
        headersSize: -1,
        bodySize: requestBody ? Buffer.byteLength(requestBody) : 0,
        ...(requestBody ? { postData: { mimeType: requestHeaders.get("content-type") || "", text: requestBody } } : {}),
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        httpVersion: "HTTP/1.1",
        headers: headerList(response.headers),
        cookies: [],
        content: {
          size: responseBuffer.length,
          mimeType: contentType,
          text: textual ? decodeBody(responseBuffer, contentType) : responseBuffer.toString("base64"),
          ...(textual ? {} : { encoding: "base64" }),
        },
        redirectURL: response.headers.get("location") || "",
        headersSize: -1,
        bodySize: responseBuffer.length,
      },
      cache: {},
      timings: { send: 0, wait: elapsed, receive: 0 },
    });
    await this.flush();
  }

  async flush() {
    const har = {
      log: {
        version: "1.2",
        creator: { name: "arca-invoice-mcp", version: "0.1.0" },
        pages: [{ startedDateTime: this.startedAt, id: "arca-direct-http", title: "ARCA RCEL direct HTTP flow", pageTimings: {} }],
        entries: this.entries,
      },
    };
    await writeFile(this.filePath, JSON.stringify(har, null, 2), { mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }
}

class DirectRcelSession {
  constructor({ jar, userAgent }) {
    this.jar = jar;
    this.userAgent = userAgent;
    this.fetch = fetchCookie(globalThis.fetch, jar);
    this.recorder = null;
  }

  setRecorder(recorder) { this.recorder = recorder; }

  async request(relativeOrAbsolute, { method = "GET", form, headers = {} } = {}) {
    const url = new URL(relativeOrAbsolute, RCEL_BASE).href;
    assertOfficialUrl(url);
    const requestHeaders = new Headers({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "es-419,es;q=0.9",
      "user-agent": this.userAgent,
      referer: RCEL_MENU_URL,
      ...headers,
    });
    let body;
    if (form) {
      body = encodeForm(form);
      requestHeaders.set("content-type", "application/x-www-form-urlencoded");
    }
    const requestCookies = await this.jar.getCookies(url);
    const started = Date.now();
    const response = await fetchOfficial(this.fetch, url, { method, headers: requestHeaders, body });
    const responseBuffer = Buffer.from(await response.arrayBuffer());
    const elapsed = Date.now() - started;
    if (this.recorder) {
      await this.recorder.record({ startedDateTime: new Date(started).toISOString(), elapsed, method, url, requestHeaders, requestCookies, requestBody: body, response, responseBuffer });
    }
    return { response, buffer: responseBuffer, text: decodeBody(responseBuffer, response.headers.get("content-type")) };
  }
}

function parsePointMetadata(html, pointValue) {
  const select = html.match(/<select[^>]+id=["']puntodeventa["'][^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (!select) throw new Error("Could not parse ARCA point-of-sale list");
  const options = [...select.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)];
  const index = options.findIndex(match => match[1] === pointValue);
  if (index < 0) throw new Error(`Point of sale ${pointValue} is not enabled`);
  const system = html.match(new RegExp(`codigoSistemaPtoVta\\[${index}\\]\\s*=\\s*["']([^"']*)`))?.[1];
  const fantasyName = html.match(new RegExp(`nombreFantasiaPtoVta\\[${index}\\]\\s*=\\s*["']([^"']*)`))?.[1] || "";
  if (!system) throw new Error(`Could not derive ARCA system for point of sale ${pointValue}`);
  return { system, fantasyName };
}

function htmlAttribute(tag, name) {
  return tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function inputValue(html, name) {
  const tag = [...html.matchAll(/<input\b[^>]*>/gi)].map(match => match[0]).find(candidate => htmlAttribute(candidate, "name") === name);
  return tag ? (htmlAttribute(tag, "value") ?? "") : undefined;
}

function formAction(html, name) {
  const forms = [...html.matchAll(/<form\b[^>]*>/gi)].map(match => match[0]);
  const form = name ? forms.find(candidate => htmlAttribute(candidate, "name") === name) : forms[0];
  return form && htmlAttribute(form, "action");
}

function cellText(row, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return row.match(new RegExp(`<td[^>]+title=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/td>`, "i"))?.[1]
    ?.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() || null;
}

export class ArcaClient {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.outputDir = path.join(cwd, "output", "arca");
    this.stateDir = path.join(cwd, ".state", "chrome");
    this.session = null;
    this.prepared = null;
    this.issuing = false;
  }

  async credentials() {
    const envPath = process.env.ARCA_ENV_FILE || path.join(this.cwd, ".env");
    const fileValues = parseEnv(await readFile(envPath, "utf8"));
    const cuil = process.env.CUIL || fileValues.CUIL;
    const password = process.env.PASS || fileValues.PASS;
    if (!cuil || !password) throw new Error(`CUIL and PASS are required in ${envPath}`);
    return { cuil: cuil.replace(/\D/g, ""), password };
  }

  async sessionIsValid() {
    if (!this.session) return false;
    try {
      const { text } = await this.session.request(RCEL_MENU_URL);
      return text.includes("RÉGIMEN DE COMPROBANTES EN LÍNEA");
    } catch { return false; }
  }

  async authenticateDirect() {
    const { cuil, password } = await this.credentials();
    const jar = new CookieJar();
    const directFetch = fetchCookie(globalThis.fetch, jar);
    const userAgent = process.env.ARCA_USER_AGENT || "arca-invoice-mcp/0.1";
    const fetchText = async (url, options = {}) => {
      assertOfficialUrl(url);
      const response = await fetchOfficial(directFetch, url, {
        ...options,
        headers: { "user-agent": userAgent, ...(options.headers || {}) },
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      return { response, text: decodeBody(buffer, response.headers.get("content-type")) };
    };

    const first = await fetchText(AUTH_URL);
    const firstAction = formAction(first.text);
    const firstViewState = inputValue(first.text, "javax.faces.ViewState");
    const nextLabel = inputValue(first.text, "F1:btnSiguiente");
    if (!firstAction || !firstViewState || !nextLabel) throw new Error("ARCA direct auth step 1 contract changed");
    const second = await fetchText(new URL(firstAction, AUTH_URL).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: first.response.url },
      body: new URLSearchParams([
        ["F1", "F1"], ["F1:username", cuil], ["F1:btnSiguiente", nextLabel], ["javax.faces.ViewState", firstViewState],
      ]).toString(),
    });

    const secondAction = formAction(second.text);
    const secondViewState = inputValue(second.text, "javax.faces.ViewState");
    const loginLabel = inputValue(second.text, "F1:btnIngresar");
    if (!secondAction || !secondViewState || !loginLabel) throw new Error("ARCA direct auth step 2 contract changed or requires an interactive challenge");
    const bridge = await fetchText(new URL(secondAction, second.response.url).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: second.response.url },
      body: new URLSearchParams([
        ["F1", "F1"], ["F1:captcha", inputValue(second.text, "F1:captcha") || ""], ["F1:username", inputValue(second.text, "F1:username") || cuil],
        ["F1:password", password], ["F1:btnIngresar", loginLabel], ["javax.faces.ViewState", secondViewState],
      ]).toString(),
    });

    const jwt = inputValue(bridge.text, "jwt");
    const bridgeAction = formAction(bridge.text, "myform");
    if (!jwt || !bridgeAction) throw new Error("ARCA rejected direct credentials or changed the JWT bridge");
    const portal = await fetchText(new URL(bridgeAction, bridge.response.url).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: bridge.response.url },
      body: new URLSearchParams({ jwt }).toString(),
    });
    if (!portal.response.url.startsWith(PORTAL_URL)) throw new Error("ARCA direct auth did not reach Portal de Clave Fiscal");

    const servicesResponse = await fetchOfficial(directFetch, `${PORTAL_URL.replace(/app\/$/, "api/")}servicios/${cuil}`, { headers: { "user-agent": userAgent } });
    const servicesPayload = await servicesResponse.json();
    const services = Array.isArray(servicesPayload) ? servicesPayload : servicesPayload.data || [];
    const rcel = services.find(service => service.serviceName === "rcel");
    if (!rcel?.url) throw new Error("RCEL is not available for this taxpayer");
    assertOfficialUrl(rcel.url);
    const grantResponse = await fetchOfficial(directFetch, `${PORTAL_URL.replace(/app\/$/, "api/")}servicios/${cuil}/servicio/rcel/autorizacion`, { headers: { "user-agent": userAgent } });
    const grant = await grantResponse.json();
    if (!grant.token || !grant.sign) throw new Error("Portal did not return an RCEL authorization grant");
    const launch = await fetchText(rcel.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: portal.response.url },
      body: new URLSearchParams({ token: grant.token, sign: grant.sign }).toString(),
    });
    if (!launch.text.includes("Seleccione la Empresa a representar")) throw new Error("Direct SSO did not reach RCEL company selection");
    const contributorId = launch.text.match(/idcontribuyente['"]\)\.value=['"]([^'"]+)/i)?.[1] || "0";
    const companyAction = formAction(launch.text, "seleccionaEmpresaForm");
    if (!companyAction) throw new Error("RCEL company-selection contract changed");
    const company = await fetchText(new URL(companyAction, launch.response.url).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: launch.response.url },
      body: new URLSearchParams({ idContribuyente: contributorId }).toString(),
    });
    if (!company.text.includes("RÉGIMEN DE COMPROBANTES EN LÍNEA")) throw new Error("Direct HTTP authentication did not reach RCEL menu");
    this.session = new DirectRcelSession({ jar, userAgent });
    this.authMode = "direct-http";
  }

  async authenticateWithBrowser({ headless }) {
    await mkdir(this.stateDir, { recursive: true });
    const context = await chromium.launchPersistentContext(this.stateDir, {
      executablePath: process.env.ARCA_CHROME_PATH || DEFAULT_CHROME,
      headless,
      viewport: { width: 1280, height: 820 },
    });
    let page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(AUTH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertOfficialUrl(page.url());
      if (await page.locator("#F1\\:username").count()) {
        const { cuil, password } = await this.credentials();
        await page.locator("#F1\\:username").fill(cuil);
        await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("#F1\\:btnSiguiente").click()]);
        await page.locator("#F1\\:password").fill(password);
        await page.locator("#F1\\:btnIngresar").click();
        await page.waitForURL(url => url.hostname === "portalcf.cloud.afip.gob.ar", { timeout: 30_000 });
      }
      if (page.url().startsWith(PORTAL_URL)) {
        await page.locator("#buscadorInput").fill("Comprobantes en línea");
        const pagePromise = context.waitForEvent("page");
        await page.getByText("Comprobantes en línea", { exact: true }).filter({ visible: true }).click();
        page = await pagePromise;
        await page.waitForLoadState("domcontentloaded");
      }
      assertOfficialUrl(page.url());
      if ((await page.locator("body").innerText()).includes("Seleccione la Empresa a representar")) {
        await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator('input[type="button"]').click()]);
      }
      if (!page.url().includes("menu_ppal.jsp")) await page.goto(RCEL_MENU_URL, { waitUntil: "domcontentloaded" });
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const browserCookies = await context.cookies();
      const jar = new CookieJar();
      for (const cookie of browserCookies) {
        if (!cookie.domain.endsWith("afip.gob.ar")) continue;
        const domain = cookie.domain.replace(/^\./, "");
        const parts = [`${cookie.name}=${cookie.value}`, `Domain=${cookie.domain}`, `Path=${cookie.path}`];
        if (cookie.secure) parts.push("Secure");
        if (cookie.httpOnly) parts.push("HttpOnly");
        await jar.setCookie(parts.join("; "), `https://${domain}${cookie.path}`);
      }
      this.session = new DirectRcelSession({ jar, userAgent });
      this.authMode = headless ? "chrome-headless" : "chrome-visible";
    } finally {
      await context.close();
    }
  }

  async ensureHttpSession() {
    if (await this.sessionIsValid()) return this.session;
    this.session = null;
    let directError;
    try {
      await this.authenticateDirect();
    } catch (error) {
      directError = error;
      const fallback = process.env.ARCA_AUTH_FALLBACK || "none";
      if (fallback === "none") throw error;
      if (!["headless", "visible"].includes(fallback)) {
        throw new Error("ARCA_AUTH_FALLBACK must be none, headless, or visible");
      }
      await this.authenticateWithBrowser({ headless: fallback !== "visible" });
    }
    if (!(await this.sessionIsValid())) {
      const suffix = directError ? ` Direct auth failed first: ${directError.message}` : "";
      throw new Error(`ARCA authentication did not produce a valid RCEL HTTP session.${suffix}`);
    }
    return this.session;
  }

  async prepareInvoice(input) {
    if (this.issuing) throw new Error("An invoice is currently being issued");
    assertDate(input.emissionDate, "emissionDate");
    assertDate(input.periodFrom, "periodFrom");
    assertDate(input.periodTo, "periodTo");
    assertDate(input.dueDate, "dueDate");
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("amount must be positive");
    if (!input.paymentMethods?.length) throw new Error("At least one payment method is required");
    const point = String(Number(input.pointOfSale || "00002"));
    await mkdir(this.outputDir, { recursive: true });
    const session = await this.ensureHttpSession();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const harPath = path.join(this.outputDir, `${stamp}-${safeSlug(input.description) || "invoice"}.har`);
    session.setRecorder(input.captureHar === false ? null : new HarRecorder(harPath));

    const start = await session.request("buscarPtosVtas.do");
    const pointMetadata = parsePointMetadata(start.text, point);
    await session.request("ajax.do?f=tiposcomp&pv=" + encodeURIComponent(point), { headers: { "x-requested-with": "XMLHttpRequest" } });
    await session.request("genComDatosEmisor.do", { method: "POST", form: [
      ["puntoDeVenta", point], ["codigoSistemaPtoVta", pointMetadata.system], ["nombreFantasia", pointMetadata.fantasyName], ["universoComprobante", "2"], ["leyenda", ""],
    ] });
    await session.request("genComDatosReceptor.do", { method: "POST", form: [
      ["fechaEmisionComprobante", input.emissionDate], ["idConcepto", "2"], ["cancelacionMonedaExtranjera", ""], ["moneda", ""], ["tipoCambio", ""],
      ["periodoFacturadoDesde", input.periodFrom], ["periodoFacturadoHasta", input.periodTo], ["vencimientoPago", input.dueDate], ["actiAsociadaId", ""], ["refComEmisor", ""],
    ] });
    const receiverResponse = await session.request(`ajax.do?f=datosreceptor2&ivareceptor=1&tipodoc=80&nrodoc=${encodeURIComponent(input.receiverCuit)}`, { headers: { "x-requested-with": "XMLHttpRequest" } });
    const receiver = JSON.parse(receiverResponse.text);
    if (receiver.estado !== "ok" || !receiver.datos?.razonSocial || !receiver.datos?.domicilios?.[0]) throw new Error("ARCA did not return valid receiver data");
    const paymentValues = [];
    if (input.paymentMethods.includes("cash")) paymentValues.push(["formaDePago", "1"]);
    if (input.paymentMethods.includes("bank_transfer")) paymentValues.push(["formaDePago", "91"]);
    await session.request("genComDatosOperacion.do", { method: "POST", form: [
      ["idIVAReceptor", "1"], ["idTipoDocReceptor", "80"], ["nroDocReceptor", input.receiverCuit], ["razonSocialReceptor", receiver.datos.razonSocial],
      ["domicilioReceptorCombo", receiver.datos.domicilios[0]], ["domicilioReceptor", receiver.datos.domicilios[0]], ["emailReceptor", ""], ...paymentValues,
      ["cmpAsociadoTipo", "91"], ["cmpAsociadoPtoVta", ""], ["cmpAsociadoNro", ""], ["cmpAsociadoCuitEmisor", ""], ["cmpAsociadoFechaEmision", ""],
      ["datoAdicionalTipo", "0"], ["datoAdicionalValor", ""], ["datoAdicionalValor", ""],
    ] });
    const total = input.amount.toFixed(2);
    const preview = await session.request("genComResumenDatos.do", { method: "POST", form: [
      ["idIVAReceptor", "1"], ["idTipoDocReceptor", "80"], ["nroDocReceptor", input.receiverCuit], ["razonSocialReceptor", receiver.datos.razonSocial],
      ["domicilioReceptor", receiver.datos.domicilios[0]], ["emailReceptor", ""], ["detalleCodigoArticulo", ""], ["detalleNroLinea", ""],
      ["detalleDescripcion", input.description], ["detalleCantidad", "1"], ["detalleMedida", "7"], ["detallePrecio", String(input.amount)],
      ["detallePorcentajeBonificacion", "0"], ["detalleImporteBonificacion", "0.00"], ["detalleTipoBonificacion", "porcentaje"], ["detalleSubtotal2", total],
      ["impuestoCodigo", "999"], ["impuestoDescripcion", ""], ["impuestoDetalle", ""], ["impuestoBaseImponible", ""], ["impuestoAlicuota", ""],
      ["impuestoMonto", ""], ["impTotalImpuestos1", ""], ["subtotal3", total], ["impTotalImpuestos2", ""], ["impTotal", total],
      ["numDecimalesCantidad", "2"], ["numDecimalesPrecioUnit", "2"],
    ] });
    if (!preview.text.includes("RESUMEN DE DATOS (PASO 4 DE 4)")) throw new Error("ARCA did not accept the direct HTTP preview flow");
    const summary = {
      invoiceType: "Factura C", pointOfSale: input.pointOfSale, emissionDate: input.emissionDate, periodFrom: input.periodFrom, periodTo: input.periodTo,
      dueDate: input.dueDate, receiverCuit: input.receiverCuit, receiverName: receiver.datos.razonSocial, receiverAddress: receiver.datos.domicilios[0],
      paymentTerms: input.paymentMethods, description: input.description, total: input.amount,
    };
    const approvalToken = randomUUID();
    this.prepared = { approvalToken, summary, harPath, input };
    return { approvalToken, summary, harPath, transport: "direct-http", authentication: this.authMode };
  }

  async listInvoices({ dateFrom, dateTo, pointOfSale = "00002", receiverCuit = "" }) {
    assertDate(dateFrom, "dateFrom");
    assertDate(dateTo, "dateTo");
    const session = await this.ensureHttpSession();
    const results = await session.request("buscarComprobantesGenerados.do", { method: "POST", form: [
      ["fechaEmisionDesde", dateFrom], ["fechaEmisionHasta", dateTo], ["idTipoComprobante", "11"],
      ["puntoDeVenta", String(Number(pointOfSale))], ["nroComprobante", ""],
      ["idTipoDocumento", receiverCuit ? "80" : ""], ["nroDocumento", receiverCuit], ["nroCodAutorizacion", ""],
    ] });
    const rows = [...results.text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map(match => match[0]);
    return rows.filter(row => /title=["']Nro\. Comprobante["']/i.test(row)).map(row => ({
      emissionDate: cellText(row, "Fecha de Emisi&oacute;n"),
      type: cellText(row, "Tipo Comprobante"),
      number: cellText(row, "Nro. Comprobante"),
      receiverDocumentType: cellText(row, "Tipo Doc. del Receptor"),
      receiverDocument: cellText(row, "Nro. Doc. del Receptor"),
      cae: cellText(row, "CAE"),
      totalArs: Number(cellText(row, "Importe Total: Pesos Argentinos")),
      documentId: row.match(/imprimirComprobante\.do\?c=(\d+)/)?.[1] || null,
    }));
  }

  async issueInvoice({ approvalToken }) {
    if (!this.prepared || !this.session) throw new Error("No invoice is prepared");
    if (approvalToken !== this.prepared.approvalToken) throw new Error("Invalid or expired approval token");
    if (this.issuing) throw new Error("Invoice issuance is already in progress; do not retry");
    this.issuing = true;
    const prepared = this.prepared;
    try {
      const { cuil } = await this.credentials();
      const point = String(Number(prepared.input.pointOfSale));
      // RCEL exposes issuance as a GET. This irreversible request is deliberately sent exactly once.
      const generated = await this.session.request(`generarComprobante.do?ts=${Date.now()}&ce=${cuil}&tc=11&pv=${point}`);
      const idComprobante = generated.text.trim();
      if (!/^\d+$/.test(idComprobante)) throw new Error(`ARCA issuance returned an uncertain result; do not retry. Inspect ${prepared.harPath}`);
      const pdf = await this.session.request(`imprimirComprobante.do?c=${encodeURIComponent(idComprobante)}`);
      if (pdf.response.headers.get("content-type") !== "application/pdf") throw new Error(`Invoice ${idComprobante} was generated, but PDF download failed; do not retry issuance`);
      const tempPath = path.join(this.outputDir, `${idComprobante}.pdf`);
      await writeFile(tempPath, pdf.buffer, { mode: 0o600 });
      const { stdout } = await execFileAsync("pdftotext", ["-layout", tempPath, "-"]);
      const number = stdout.match(/Comp\. Nro:\s*(\d+)/)?.[1];
      const cae = stdout.match(/CAE N°:\s*(\d+)/)?.[1];
      const caeDueDate = stdout.match(/Fecha de Vto\. de CAE:\s*([0-9/]+)/)?.[1];
      if (!number || !cae) throw new Error(`Invoice PDF saved at ${tempPath}, but number/CAE extraction failed; do not retry issuance`);
      const finalPdfPath = path.join(this.outputDir, `${prepared.summary.pointOfSale}-${number}.pdf`);
      await writeFile(finalPdfPath, pdf.buffer, { mode: 0o600 });
      this.prepared = null;
      this.session.setRecorder(null);
      await chmod(prepared.harPath, 0o600).catch(() => {});
      return { number, cae, caeDueDate, pdfPath: finalPdfPath, harPath: prepared.harPath, transport: "direct-http" };
    } finally { this.issuing = false; }
  }

  async discardPreparedInvoice() {
    const discarded = Boolean(this.prepared);
    this.prepared = null;
    if (this.session) this.session.setRecorder(null);
    return { discarded };
  }

  status() {
    return { authenticated: Boolean(this.session), authentication: this.authMode || null, prepared: this.prepared ? { summary: this.prepared.summary, harPath: this.prepared.harPath } : null, issuing: this.issuing };
  }

  async close() {
    if (this.session?.recorder) await this.session.recorder.flush();
  }
}
