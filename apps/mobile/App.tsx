import React, { useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  AudioModule, RecordingPresets, setAudioModeAsync,
  useAudioPlayer, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
const ENDPOINT = '/voice-notes';

type OrderStatus = 'draft' | 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
type StatusRead = { order_id: string; status: OrderStatus; allowed_next: OrderStatus[]; review_revision: number };
type StatusEvent = {
  id: string; order_id: string; from_status: OrderStatus; to_status: OrderStatus;
  changed_at: string; changed_by_user_id: string; note: string | null;
};
type StatusChangeResult = { order: StatusRead; event: StatusEvent };
const STATE_LABELS: Record<OrderStatus, string> = {
  draft: 'Borrador', pending: 'Pendiente', confirmed: 'Confirmado',
  in_progress: 'En proceso', completed: 'Completado', cancelled: 'Cancelado',
};

type CatalogProduct = {
  id: string; sku: string; name: string; unit: string; price_mxn: string;
  cost_mxn: string; is_active: boolean;
};
type QuoteTaxConfig = { configured: boolean; tax_percent: string | null };
type QuoteLineResult = {
  product_id: string; product_name: string; product_sku: string;
  quantity: string; unit_price: string; line_subtotal: string;
};
type QuoteResult = {
  id: string; order_id: string; version: number; status: 'draft' | 'approved';
  subtotal: string; discount_percent: string; discount_amount: string;
  tax_percent: string; tax_amount: string; taxable_base: string; total: string;
  direct_cost: string; estimated_gross_margin: string; items: QuoteLineResult[];
};

type LoginResponse = { access_token: string; token_type: string; expires_in: number };
type VoiceNote = { id: string; byte_size: number; duration_ms: number | null; created_at: string };
type DraftOrder = { id: string; status: string; raw_text: string; review_revision: number };
type SearchOrder = DraftOrder & {
  created_at: string; created_by_user_id: string; source: string;
};
type SearchPage = {
  items: SearchOrder[]; total: number; limit: number; offset: number;
  has_more: boolean; next_offset: number | null;
};
type OrderReview = {
  id: string; organization_id: string; status: string; raw_text: string;
  suggested_quantity: string | null; suggested_due_date: string | null;
  reviewed_quantity: string | null; reviewed_due_date: string | null;
  reviewed_at: string | null; confirmed_at: string | null;
  review_revision: number; requires_manual_review: boolean;
};

async function apiRequest<T>(path: string, init: RequestInit): Promise<T> {
  if (!/^https?:\/\//.test(API_URL)) {
    throw new Error('Configura EXPO_PUBLIC_API_URL en apps/mobile/.env');
  }
  // Evita que el formulario quede indefinidamente en modo de carga si falla la red.
  // Las cargas de audio tienen un plazo mayor que el inicio de sesion.
  const controller = new AbortController();
  const timeoutMs = path === ENDPOINT && init.method === 'POST' ? 120000 : 15000;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  try {
    // Mantener fetch habitual para JSON. Solo multipart necesita expo/fetch.
    const requestUrl = `${API_URL}${path}`;
    const requestOptions = { ...init, signal: controller.signal };
    const response = init.body instanceof FormData
      ? await expoFetch(requestUrl, requestOptions)
      : await fetch(requestUrl, requestOptions);
    const text = await response.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data
        ? JSON.stringify((data as { detail: unknown }).detail) : `HTTP ${response.status}`;
      throw new Error(`Error ${response.status}: ${detail}`);
    }
    return data as T;
  } catch (error) {
    if (expired) {
      throw new Error(`Tiempo de espera agotado. No hubo respuesta de ${API_URL}. Verifica la IP, FastAPI y la red Wi-Fi.`);
    }
    if (error instanceof TypeError && /network request failed|failed to fetch/i.test(error.message)) {
      throw new Error(`No se pudo conectar con ${API_URL}. Verifica la IP y la conexion de red.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function ActionButton({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      onPress={onPress} disabled={disabled} style={({ pressed }) => [
        styles.button, secondary && styles.buttonSecondary,
        (pressed || disabled) && styles.buttonFaded,
      ]}>
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [organizationId, setOrganizationId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [tab, setTab] = useState<'voice' | 'text' | 'review' | 'search' | 'quote'>('voice');
  const [micDenied, setMicDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [draftText, setDraftText] = useState('');
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [savedNotes, setSavedNotes] = useState<VoiceNote[]>([]);
  const [draftOrders, setDraftOrders] = useState<DraftOrder[]>([]);
  const [activeReview, setActiveReview] = useState<OrderReview | null>(null);
  const [reviewQty, setReviewQty] = useState('');
  const [reviewDueDate, setReviewDueDate] = useState('');
  const [orderStatus, setOrderStatus] = useState<StatusRead | null>(null);
  const [statusHistory, setStatusHistory] = useState<StatusEvent[]>([]);
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState<OrderStatus | ''>('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterMine, setFilterMine] = useState(false);
  const [searchPage, setSearchPage] = useState<SearchPage | null>(null);

  const [quoteOrders, setQuoteOrders] = useState<SearchOrder[]>([]);
  const [quoteOrderId, setQuoteOrderId] = useState('');
  const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([]);
  const [quoteProductId, setQuoteProductId] = useState('');
  const [quoteQuantity, setQuoteQuantity] = useState('1.000');
  const [quoteDiscount, setQuoteDiscount] = useState('0.00');
  const [quoteTaxInput, setQuoteTaxInput] = useState('16.00');
  const [newProductSku, setNewProductSku] = useState('DEMO-001');
  const [newProductName, setNewProductName] = useState('Producto de demostracion');
  const [newProductPrice, setNewProductPrice] = useState('25.50');
  const [newProductCost, setNewProductCost] = useState('9.25');
  const [quoteTaxConfig, setQuoteTaxConfig] = useState<QuoteTaxConfig | null>(null);
  const [quotePreview, setQuotePreview] = useState<QuoteResult | null>(null);
  const [quoteHistory, setQuoteHistory] = useState<QuoteResult[]>([]);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const player = useAudioPlayer(null);

  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  function errorMessage(error: unknown) {
    setMessage(error instanceof Error ? error.message : 'Error inesperado');
  }

  async function logIn() {
    if (!organizationId.trim() || !email.trim() || !password) {
      setMessage('Introduce la organizacion, correo y contrasena.');
      return;
    }
    setBusy(true); setMessage('Conectando con NEXO AI...');
    try {
      const result = await apiRequest<LoginResponse>('/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: organizationId.trim(), email: email.trim(), password,
        }),
      });
      setToken(result.access_token);
      setPassword('');
      setMessage('Sesion iniciada. Puedes grabar audio o registrar texto.');
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function logOut() {
    if (recorderState.isRecording || busy) return;
    setBusy(true);
    try {
      await apiRequest('/auth/logout', { method: 'POST', headers: auth });
    } catch { /* El token se descarta aunque el servidor no este disponible. */ }
    setToken(null); setRecordingUri(null); setSavedNotes([]);
    setDraftOrders([]); setActiveReview(null); setReviewQty(''); setReviewDueDate('');
    setOrderStatus(null); setStatusHistory([]); setSearchPage(null);
    setQuoteOrders([]); setQuoteHistory([]); setQuotePreview(null); setQuoteOrderId('');
    player.pause(); setMessage('Sesion cerrada.'); setBusy(false);
  }

  async function startRecording() {
    if (busy || recorderState.isRecording) return;
    setBusy(true); setMessage('');
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setMicDenied(true); setTab('text');
        setMessage('No hay permiso de microfono. Puedes capturar texto sin restricciones.');
        return;
      }
      setMicDenied(false);
      player.pause(); setRecordingUri(null);
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function stopRecording() {
    if (busy || !recorderState.isRecording) return;
    setBusy(true);
    try {
      const duration = recorderState.durationMillis;
      await recorder.stop();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      if (!recorder.uri) throw new Error('No se genero un archivo de audio.');
      setRecordingUri(recorder.uri);
      setRecordingDurationMs(duration);
      player.replace({ uri: recorder.uri });
      setMessage('Grabacion lista. Escuchala antes de enviarla.');
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function previewAudio() {
    if (!recordingUri || busy) return;
    try {
      await player.seekTo(0);
      player.play();
    } catch (error) { errorMessage(error); }
  }

  async function sendAudio() {
    if (!token || !recordingUri || busy || recorderState.isRecording) return;
    setBusy(true); setMessage('Enviando audio...');
    try {
      // SDK 58: expo/fetch no admite objetos React Native { uri, name, type }.
      // File es un Blob nativo que puede serializarse como multipart/form-data.
      const audioFile = new File(recordingUri);
      if (!audioFile.exists || audioFile.size === 0) {
        throw new Error('El archivo grabado no existe o esta vacio. Graba de nuevo.');
      }
      const form = new FormData();
      form.append('file', audioFile, 'nexo-nota.m4a');
      if (recordingDurationMs > 0) {
        form.append('duration_ms', String(recordingDurationMs));
      }
      const result = await apiRequest<VoiceNote>(ENDPOINT, {
        method: 'POST', headers: auth, body: form,
        // No asignar Content-Type: fetch debe crear el boundary multipart.
      });
      player.pause(); setRecordingUri(null);
      setSavedNotes((prev) => [result, ...prev]);
      setMessage(`Audio recibido por NEXO AI (ID: ${result.id.slice(0, 8)}).`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function saveText() {
    if (!token || busy || !draftText.trim()) {
      setMessage('Escribe la solicitud antes de guardarla.');
      return;
    }
    setBusy(true); setMessage('');
    try {
      const result = await apiRequest<{ id: string; status: string }>('/orders', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_text: draftText.trim() }),
      });
      setDraftText('');
      setTab('review'); setDraftOrders([]); setActiveReview(null); setOrderStatus(null); setStatusHistory([]);
      setMessage(`Borrador ${result.id.slice(0, 8)} guardado. Abre «Cargar solicitudes» para revisar y confirmar.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function refreshNotes() {
    if (!token || busy) return;
    setBusy(true);
    try {
      const notes = await apiRequest<VoiceNote[]>(`${ENDPOINT}?only_mine=true&limit=20`, {
        method: 'GET', headers: auth,
      });
      setSavedNotes(notes);
      setMessage(`Se encontraron ${notes.length} audios propios.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function refreshOrders() {
    if (!token || busy) return;
    setBusy(true); setMessage('Buscando solicitudes...');
    try {
      const rows = await apiRequest<DraftOrder[]>('/orders?only_mine=true&limit=50', {
        method: 'GET', headers: auth,
      });
      setDraftOrders(rows);
      setMessage(`${rows.length} solicitudes encontradas. Selecciona una para revisar.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function searchOrders(offset = 0) {
    if (!token || busy) return;
    const from = filterFrom.trim(); const to = filterTo.trim();
    if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
        (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      setMessage('Usa fechas AAAA-MM-DD en los filtros.'); return;
    }
    if (from && to && from > to) {
      setMessage('Fecha desde no puede ser posterior a fecha hasta.'); return;
    }
    const params = new URLSearchParams({ limit: '10', offset: String(offset) });
    if (filterStatus) params.set('status', filterStatus);
    if (filterText.trim()) params.set('q', filterText.trim());
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);
    if (filterMine) params.set('only_mine', 'true');
    setBusy(true); setMessage('Buscando pedidos de la organizacion...');
    try {
      const page = await apiRequest<SearchPage>(`/orders/search?${params.toString()}`, {
        method: 'GET', headers: auth,
      });
      setSearchPage(page);
      setMessage(`${page.total} pedidos coinciden. Mostrando ${page.items.length} resultados.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  function clearSearch() {
    setFilterText(''); setFilterStatus(''); setFilterFrom(''); setFilterTo('');
    setFilterMine(false); setSearchPage(null); setMessage('Filtros limpiados.');
  }

  async function openReview(orderId: string) {
    if (!token || busy) return;
    setBusy(true); setMessage('Cargando formulario...');
    try {
      const [review, current, history] = await Promise.all([
        apiRequest<OrderReview>(`/orders/${orderId}/review`, { method: 'GET', headers: auth }),
        apiRequest<StatusRead>(`/orders/${orderId}/status`, { method: 'GET', headers: auth }),
        apiRequest<StatusEvent[]>(`/orders/${orderId}/history?limit=20`, { method: 'GET', headers: auth }),
      ]);
      setOrderStatus(current);
      setStatusHistory(history);
      setActiveReview(review);
      setReviewQty(review.reviewed_quantity ?? review.suggested_quantity ?? '');
      setReviewDueDate(review.reviewed_due_date ?? review.suggested_due_date ?? '');
      setMessage(['draft', 'pending'].includes(review.status)
        ? 'Corrige cantidad y fecha, guarda la revisión y después confirma.'
        : `Pedido ${review.status}: los valores confirmados son de solo lectura.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function saveReviewedOrder() {
    if (!activeReview || !token || busy || !['draft', 'pending'].includes(activeReview.status)) return;
    // Validacion de UX; la API valida nuevamente con Decimal y Date.
    const quantity = reviewQty.trim();
    const due = reviewDueDate.trim();
    if (!/^(?:\d{1,9})(?:\.\d{1,3})?$/.test(quantity) || Number(quantity) <= 0) {
      setMessage('Introduce una cantidad mayor a cero, con hasta 3 decimales.'); return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      setMessage('La fecha debe tener formato AAAA-MM-DD.'); return;
    }
    setBusy(true); setMessage('Guardando datos corregidos...');
    try {
      const result = await apiRequest<OrderReview>(`/orders/${activeReview.id}/review`, {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity, due_date: due, expected_revision: activeReview.review_revision }),
      });
      setActiveReview(result);
      setReviewQty(String(result.reviewed_quantity)); setReviewDueDate(String(result.reviewed_due_date));
      setMessage('Revisión guardada. Comprueba los datos y pulsa «Confirmar pedido».');
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  const reviewIsSaved = !!activeReview?.reviewed_quantity && !!activeReview.reviewed_due_date
    && Number(reviewQty.trim()) === Number(activeReview.reviewed_quantity)
    && reviewDueDate.trim() === activeReview.reviewed_due_date;

  async function confirmReviewedOrder() {
    if (!token || !activeReview || !reviewIsSaved || busy || !['draft', 'pending'].includes(activeReview.status)) return;
    setBusy(true); setMessage('Confirmando el pedido...');
    try {
      const updated = await apiRequest<OrderReview>(`/orders/${activeReview.id}/confirm`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: activeReview.review_revision }),
      });
      setActiveReview(updated);
      const [current, history] = await Promise.all([
        apiRequest<StatusRead>(`/orders/${updated.id}/status`, { method: 'GET', headers: auth }),
        apiRequest<StatusEvent[]>(`/orders/${updated.id}/history?limit=20`, { method: 'GET', headers: auth }),
      ]);
      setOrderStatus(current); setStatusHistory(history);
      setDraftOrders(prev => prev.map(order => order.id === updated.id
        ? { ...order, status: updated.status, review_revision: updated.review_revision } : order));
      setMessage(`Pedido ${updated.id.slice(0, 8)} CONFIRMADO con ${updated.reviewed_quantity} unidades para el ${updated.reviewed_due_date}.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function changeOrderStatus(toStatus: OrderStatus) {
    if (!token || !activeReview || !orderStatus || busy) return;
    const orderId = activeReview.id;
    setBusy(true); setMessage(`Cambiando a ${STATE_LABELS[toStatus]}...`);
    try {
      const result = await apiRequest<StatusChangeResult>(`/orders/${orderId}/status`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_status: orderStatus.status, to_status: toStatus }),
      });
      setOrderStatus(result.order);
      setStatusHistory(prev => [result.event, ...prev].slice(0, 20));
      setActiveReview(prev => prev && prev.id === orderId ? { ...prev, status: result.order.status } : prev);
      setDraftOrders(prev => prev.map(order => order.id === orderId
        ? { ...order, status: result.order.status } : order));
      setMessage(`Pedido ${orderId.slice(0, 8)} ahora esta ${STATE_LABELS[toStatus]}.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  function requestStatusChange(toStatus: OrderStatus) {
    if (toStatus === 'cancelled' || toStatus === 'completed') {
      Alert.alert('Confirmar cambio de estado',
        `¿Marcar el pedido como ${STATE_LABELS[toStatus]}? Esta accion no se puede revertir.`,
        [
          { text: 'Volver', style: 'cancel' },
          { text: 'Confirmar', style: 'destructive', onPress: () => { void changeOrderStatus(toStatus); } },
        ]);
      return;
    }
    void changeOrderStatus(toStatus);
  }

  async function loadQuoteWorkspace() {
    if (!token || busy) return;
    setBusy(true); setMessage('Cargando catálogo y pedidos...');
    try {
      const [orders, products, tax] = await Promise.all([
        apiRequest<SearchPage>('/orders/search?limit=20', { method: 'GET', headers: auth }),
        apiRequest<CatalogProduct[]>('/products/quotable?limit=100', { method: 'GET', headers: auth }),
        apiRequest<QuoteTaxConfig>('/quotes/tax-config', { method: 'GET', headers: auth }),
      ]);
      setQuoteOrders(orders.items.filter(order => !['completed', 'cancelled'].includes(order.status)));
      setCatalogProducts(products);
      setQuoteTaxConfig(tax);
      if (tax.tax_percent !== null) setQuoteTaxInput(String(tax.tax_percent));
      if (products.length && !products.some(prod => prod.id === quoteProductId)) setQuoteProductId(products[0].id);
      setMessage(tax.configured ? 'Catálogo y pedidos listos.' : 'Configura explícitamente el impuesto antes de cotizar.');
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function selectQuoteOrder(id: string) {
    if (!token || busy) return;
    setQuoteOrderId(id); setQuotePreview(null);
    setBusy(true); setMessage('Consultando versiones...');
    try {
      const versions = await apiRequest<QuoteResult[]>(`/quotes?order_id=${encodeURIComponent(id)}`, {
        method: 'GET', headers: auth,
      });
      setQuoteHistory(versions); setMessage(`Pedido ${id.slice(0, 8)} seleccionado.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function createCatalogProduct() {
    if (!token || busy) return;
    if (!newProductSku.trim() || !newProductName.trim()
        || !/^\d{1,10}(?:\.\d{1,2})?$/.test(newProductPrice.trim())
        || !/^\d{1,10}(?:\.\d{1,2})?$/.test(newProductCost.trim())) {
      setMessage('Introduce SKU, nombre, precio y costo válidos (dos decimales).'); return;
    }
    setBusy(true); setMessage('Registrando producto aprobado...');
    try {
      const p = await apiRequest<CatalogProduct>('/products', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: newProductSku.trim(), name: newProductName.trim(),
          unit: 'pieza', price_mxn: newProductPrice.trim(), cost_mxn: newProductCost.trim(),
          base_production_minutes: '4.00' }),
      });
      setCatalogProducts(prev => [...prev, p]); setQuoteProductId(p.id);
      setMessage(`Producto ${p.sku} guardado con precio de catálogo. Puedes cotizarlo.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function configureQuoteTax() {
    if (!token || busy) return;
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(quoteTaxInput.trim()) || Number(quoteTaxInput) > 100) {
      setMessage('Impuesto inválido: escribe un porcentaje entre 0 y 100 con hasta 2 decimales.'); return;
    }
    setBusy(true); setMessage('Configurando impuesto...');
    try {
      const result = await apiRequest<QuoteTaxConfig>('/quotes/tax-config', {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tax_percent: quoteTaxInput.trim() }),
      });
      setQuoteTaxConfig(result); setMessage('Impuesto configurado por el propietario.');
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  function quotePayload() {
    if (!quoteOrderId || !quoteProductId) throw new Error('Selecciona un pedido y un producto.');
    if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(quoteQuantity.trim()) || Number(quoteQuantity) <= 0) {
      throw new Error('Cantidad inválida: valor mayor a cero y máximo 3 decimales.');
    }
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(quoteDiscount.trim()) || Number(quoteDiscount) > 100) {
      throw new Error('Descuento inválido: valor entre 0 y 100 con máximo 2 decimales.');
    }
    return {
      order_id: quoteOrderId, discount_percent: quoteDiscount.trim(),
      items: [{ product_id: quoteProductId, quantity: quoteQuantity.trim() }],
    };
  }

  async function calculateQuote(persist: boolean) {
    if (!token || busy) return;
    setBusy(true); setMessage(persist ? 'Guardando nueva versión...' : 'Calculando cotización...');
    try {
      const body = quotePayload();
      const result = await apiRequest<QuoteResult>(persist ? '/quotes' : '/quotes/preview', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setQuotePreview(result);
      if (persist) {
        const versions = await apiRequest<QuoteResult[]>(`/quotes?order_id=${encodeURIComponent(quoteOrderId)}`, {
          method: 'GET', headers: auth,
        });
        setQuoteHistory(versions);
      }
      setMessage(persist ? `Cotización versión ${result.version} guardada como borrador.`
        : 'Vista previa calculada sin guardar ni modificar pedidos.');
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function approveQuote(id: string) {
    if (!token || busy) return;
    Alert.alert('Aprobar cotización', '¿Aprobar la versión más reciente? Solo el propietario puede hacerlo.', [
      { text: 'Volver', style: 'cancel' },
      { text: 'Aprobar', onPress: () => { void (async () => {
        setBusy(true); setMessage('Aprobando cotización...');
        try {
          const updated = await apiRequest<QuoteResult>(`/quotes/${id}/approve`, {
            method: 'POST', headers: auth,
          });
          setQuoteHistory(prev => prev.map(x => x.id === id ? updated : x));
          setQuotePreview(updated);
          setMessage(`Cotización versión ${updated.version} aprobada. PDF disponible en RF-014.`);
        } catch (error) { errorMessage(error); }
        finally { setBusy(false); }
      })(); } },
    ]);
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>NEXO AI</Text>
          <Text style={styles.heading}>Solicitudes inteligentes</Text>
          <Text style={styles.caption}>Captura, pedidos y cotizaciones · RF-013</Text>

          {!token ? (
            <View style={styles.card}>
              <Text style={styles.subtitle}>Inicio de sesion</Text>
              <TextInput style={styles.input} placeholder="UUID de organizacion" placeholderTextColor="#94A3B8"
                accessibilityLabel="Organizacion" value={organizationId} onChangeText={setOrganizationId}
                autoCapitalize="none" autoCorrect={false} />
              <TextInput style={styles.input} placeholder="Correo" placeholderTextColor="#94A3B8"
                accessibilityLabel="Correo" value={email} onChangeText={setEmail}
                autoCapitalize="none" keyboardType="email-address" autoCorrect={false} />
              <TextInput style={styles.input} placeholder="Contrasena" placeholderTextColor="#94A3B8"
                accessibilityLabel="Contrasena" value={password} onChangeText={setPassword}
                secureTextEntry autoCapitalize="none" />
              <ActionButton label="Iniciar sesion" onPress={logIn} disabled={busy} />
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.subtitle}>Nueva solicitud</Text>
              <View style={styles.tabs}>
                <Pressable onPress={() => setTab('voice')} style={[styles.tab, tab === 'voice' && styles.tabActive]}>
                  <Text style={styles.tabText}>Voz</Text>
                </Pressable>
                <Pressable onPress={() => setTab('text')} style={[styles.tab, tab === 'text' && styles.tabActive]}>
                  <Text style={styles.tabText}>Texto</Text>
                </Pressable>
                <Pressable onPress={() => setTab('review')} style={[styles.tab, tab === 'review' && styles.tabActive]}>
                  <Text style={styles.tabText}>Revisar</Text>
                </Pressable>
                <Pressable onPress={() => setTab('search')} style={[styles.tab, tab === 'search' && styles.tabActive]}>
                  <Text style={styles.tabText}>Buscar</Text>
                </Pressable>
                <Pressable onPress={() => setTab('quote')} style={[styles.tab, tab === 'quote' && styles.tabActive]}>
                  <Text style={styles.tabText}>Cotizar</Text>
                </Pressable>
              </View>
              {tab === 'voice' ? (
                <View style={styles.section}>
                  <Text style={styles.help}>El microfono solo se solicita al comenzar a grabar.</Text>
                  {micDenied && <Text style={styles.notice}>Permiso denegado. Usa la pestaña Texto manual.</Text>}
                  {recorderState.isRecording ? (
                    <>
                      <Text style={styles.timer}>{Math.round(recorderState.durationMillis / 1000)} segundos</Text>
                      <ActionButton label="Detener grabacion" onPress={stopRecording} disabled={busy} />
                    </>
                  ) : (
                    <ActionButton label="Grabar audio" onPress={startRecording} disabled={busy} />
                  )}
                  {!!recordingUri && !recorderState.isRecording && (
                    <>
                      <Text style={styles.help}>Grabacion lista para revisar.</Text>
                      <ActionButton label="Escuchar grabacion" onPress={previewAudio} disabled={busy} secondary />
                      <ActionButton label="Enviar nota de voz" onPress={sendAudio} disabled={busy} />
                      <ActionButton label="Descartar nota" onPress={() => {
                        player.pause(); setRecordingUri(null); setMessage('Nota descartada.');
                      }} disabled={busy} secondary />
                    </>
                  )}
                </View>
              ) : tab === 'text' ? (
                <View style={styles.section}>
                  <Text style={styles.help}>Disponible aun cuando se deniega el permiso del microfono.</Text>
                  <TextInput style={[styles.input, styles.multi]} multiline maxLength={5000}
                    placeholder="Ej. Necesito 30 playeras estampadas para el viernes..."
                    placeholderTextColor="#94A3B8" accessibilityLabel="Texto de solicitud"
                    value={draftText} onChangeText={setDraftText} />
                  <ActionButton label="Guardar borrador de texto" onPress={saveText} disabled={busy || !draftText.trim()} />
                </View>
              ) : tab === 'review' ? (
                <View style={styles.section}>
                  <Text style={styles.help}>Los audios aun no se transcriben automaticamente. Revisa borradores creados desde texto.</Text>
                  <ActionButton label="Cargar mis solicitudes" onPress={refreshOrders} disabled={busy} secondary />
                  {draftOrders.slice(0, 20).map((order) => (
                    <Pressable key={order.id} onPress={() => openReview(order.id)} disabled={busy}
                      accessibilityRole="button" style={styles.orderRow}>
                      <Text style={styles.saved}>{order.id.slice(0, 8)} · {order.status}</Text>
                      <Text style={styles.help} numberOfLines={2}>{order.raw_text}</Text>
                      <Text style={styles.link}>Abrir revisión</Text>
                    </Pressable>
                  ))}
                  {!!activeReview && (
                    <View style={styles.reviewPanel}>
                      <Text style={styles.subtitle}>Revisión de pedido</Text>
                      <Text style={styles.help}>Solicitud original (solo lectura):</Text>
                      <Text style={styles.rawText}>{activeReview.raw_text}</Text>
                      {!!activeReview.suggested_quantity && <Text style={styles.help}>
                        Propuesta: {activeReview.suggested_quantity} unidades
                      </Text>}
                      {!!activeReview.suggested_due_date && <Text style={styles.help}>
                        Fecha propuesta: {activeReview.suggested_due_date}
                      </Text>}
                      <Text style={styles.help}>Cantidad corregida:</Text>
                      <TextInput style={styles.input} accessibilityLabel="Cantidad corregida"
                        placeholder="Ej. 40" placeholderTextColor="#94A3B8" keyboardType="decimal-pad"
                        value={reviewQty} onChangeText={setReviewQty}
                        editable={['draft', 'pending'].includes(activeReview.status) && !busy} />
                      <Text style={styles.help}>Fecha corregida (AAAA-MM-DD):</Text>
                      <TextInput style={styles.input} accessibilityLabel="Fecha de entrega corregida"
                        placeholder="2026-12-19" placeholderTextColor="#94A3B8" autoCapitalize="none"
                        value={reviewDueDate} onChangeText={setReviewDueDate}
                        editable={['draft', 'pending'].includes(activeReview.status) && !busy} />
                      {['draft', 'pending'].includes(activeReview.status) ? (
                        <>
                          <ActionButton label="Guardar revisión" onPress={saveReviewedOrder} disabled={busy} secondary />
                          <Text style={styles.help}>La confirmación solo usa los valores guardados, nunca la propuesta sin revisar.</Text>
                          <ActionButton label="Confirmar pedido" onPress={confirmReviewedOrder}
                            disabled={busy || !reviewIsSaved} />
                        </>
                      ) : <Text style={styles.notice}>Pedido en etapa operativa o cerrado; no admite ediciones.</Text>}
                    </View>
                  )}
                  {!!activeReview && !['completed', 'cancelled'].includes(activeReview.status) && (
                    <ActionButton label="Cotizar este pedido" secondary disabled={busy}
                      onPress={() => { setQuoteOrderId(activeReview.id); setTab('quote');
                        void selectQuoteOrder(activeReview.id); }} />
                  )}
                  {!!activeReview && !!orderStatus && (
                    <View style={styles.reviewPanel}>
                      <Text style={styles.subtitle}>Estado e historial</Text>
                      <Text style={styles.rawText}>Estado actual: {STATE_LABELS[orderStatus.status]}</Text>
                      <Text style={styles.help}>Las acciones disponibles respetan las transiciones permitidas.</Text>
                      {orderStatus.allowed_next.map(next => (
                        <ActionButton key={next} label={`Marcar como ${STATE_LABELS[next]}`}
                          onPress={() => requestStatusChange(next)} disabled={busy} secondary />
                      ))}
                      {orderStatus.status === 'pending' && (
                        <Text style={styles.help}>Puedes guardar la revisión y confirmar desde el formulario de arriba.</Text>
                      )}
                      {orderStatus.allowed_next.length === 0 && (
                        <Text style={styles.notice}>Estado final: no admite otras transiciones.</Text>
                      )}
                      <Text style={styles.subtitle}>Movimientos registrados</Text>
                      {statusHistory.length === 0 && (
                        <Text style={styles.help}>Todavía no existen transiciones registradas.</Text>
                      )}
                      {statusHistory.map(event => (
                        <View key={event.id} style={styles.historyRow}>
                          <Text style={styles.saved}>
                            {STATE_LABELS[event.from_status]} → {STATE_LABELS[event.to_status]}
                          </Text>
                          <Text style={styles.help}>{new Date(event.changed_at).toLocaleString()}</Text>
                          <Text style={styles.saved}>Usuario: {event.changed_by_user_id.slice(0, 8)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              ) : tab === 'quote' ? (
                <View style={styles.section}>
                  <Text style={styles.subtitle}>Costeo y cotización · RF-013</Text>
                  <Text style={styles.help}>Se usan precios aprobados en el catálogo. El cálculo no confirma pedidos ni consume inventario.</Text>
                  <ActionButton label="Cargar productos, pedidos e impuestos" onPress={loadQuoteWorkspace}
                    disabled={busy} secondary />
                  <Text style={styles.help}>Impuesto configurado: {quoteTaxConfig?.configured
                    ? `${quoteTaxConfig.tax_percent}%` : 'No configurado'}</Text>
                  <Text style={styles.help}>Solo el propietario puede configurar la tasa; 0% también requiere configuración explícita.</Text>
                  <TextInput style={styles.input} accessibilityLabel="Impuesto porcentual"
                    placeholder="Ej. 16.00" placeholderTextColor="#94A3B8" keyboardType="decimal-pad"
                    value={quoteTaxInput} onChangeText={setQuoteTaxInput} />
                  <ActionButton label="Guardar impuesto (propietario)" onPress={configureQuoteTax}
                    disabled={busy} secondary />
                  <Text style={styles.subtitle}>1. Seleccionar pedido</Text>
                  {quoteOrders.length === 0 && (
                    <Text style={styles.notice}>Pulsa cargar para consultar los pedidos de tu empresa.</Text>
                  )}
                  {quoteOrders.map(order => (
                    <Pressable key={order.id} accessibilityRole="button" disabled={busy}
                      onPress={() => { void selectQuoteOrder(order.id); }}
                      style={[styles.orderRow, quoteOrderId === order.id && styles.tabActive]}>
                      <Text style={styles.saved}>{order.id.slice(0, 8)} · {STATE_LABELS[order.status as OrderStatus]}</Text>
                      <Text style={styles.help} numberOfLines={2}>{order.raw_text}</Text>
                      <Text style={styles.link}>{quoteOrderId === order.id ? 'Pedido seleccionado' : 'Seleccionar pedido'}</Text>
                    </Pressable>
                  ))}
                  <Text style={styles.subtitle}>2. Producto y cantidad</Text>
                  <Text style={styles.help}>Si todavía no tienes productos, el propietario puede crear uno de prueba aquí. No se crea automáticamente.</Text>
                  <TextInput style={styles.input} accessibilityLabel="SKU del producto"
                    placeholder="SKU, ej. DEMO-001" placeholderTextColor="#94A3B8"
                    value={newProductSku} onChangeText={setNewProductSku} autoCapitalize="characters" />
                  <TextInput style={styles.input} accessibilityLabel="Nombre del producto"
                    placeholder="Nombre del producto" placeholderTextColor="#94A3B8"
                    value={newProductName} onChangeText={setNewProductName} />
                  <TextInput style={styles.input} accessibilityLabel="Precio aprobado MXN"
                    placeholder="Precio de venta, ej. 25.50" placeholderTextColor="#94A3B8"
                    keyboardType="decimal-pad" value={newProductPrice} onChangeText={setNewProductPrice} />
                  <TextInput style={styles.input} accessibilityLabel="Costo directo MXN"
                    placeholder="Costo directo, ej. 9.25" placeholderTextColor="#94A3B8"
                    keyboardType="decimal-pad" value={newProductCost} onChangeText={setNewProductCost} />
                  <ActionButton label="Crear producto (propietario)" onPress={createCatalogProduct}
                    disabled={busy} secondary />
                  {catalogProducts.length === 0 && (
                    <Text style={styles.notice}>No hay productos activos. El propietario debe crear uno desde /docs → POST /api/v1/products.</Text>
                  )}
                  {catalogProducts.map(prod => (
                    <Pressable key={prod.id} accessibilityRole="button" disabled={busy}
                      onPress={() => { setQuoteProductId(prod.id); setQuotePreview(null); }}
                      style={[styles.orderRow, quoteProductId === prod.id && styles.tabActive]}>
                      <Text style={styles.saved}>{prod.sku} · {prod.name}</Text>
                      <Text style={styles.help}>Precio aprobado: ${prod.price_mxn} MXN / {prod.unit}</Text>
                      <Text style={styles.link}>{quoteProductId === prod.id ? 'Seleccionado' : 'Seleccionar'}</Text>
                    </Pressable>
                  ))}
                  <Text style={styles.help}>Cantidad (hasta tres decimales):</Text>
                  <TextInput style={styles.input} accessibilityLabel="Cantidad de cotización"
                    value={quoteQuantity} onChangeText={setQuoteQuantity} keyboardType="decimal-pad"
                    placeholder="1.000" placeholderTextColor="#94A3B8" />
                  <Text style={styles.help}>Descuento autorizado (%):</Text>
                  <TextInput style={styles.input} accessibilityLabel="Descuento porcentual"
                    value={quoteDiscount} onChangeText={setQuoteDiscount} keyboardType="decimal-pad"
                    placeholder="0.00" placeholderTextColor="#94A3B8" />
                  <ActionButton label="Calcular vista previa" onPress={() => { void calculateQuote(false); }}
                    disabled={busy || !quoteOrderId || !quoteProductId || !quoteTaxConfig?.configured} secondary />
                  {!!quotePreview && (
                    <View style={styles.reviewPanel}>
                      <Text style={styles.subtitle}>Resultado · MXN</Text>
                      <Text style={styles.saved}>Subtotal: ${quotePreview.subtotal}</Text>
                      <Text style={styles.saved}>Descuento ({quotePreview.discount_percent}%): -${quotePreview.discount_amount}</Text>
                      <Text style={styles.saved}>Base gravable: ${quotePreview.taxable_base}</Text>
                      <Text style={styles.saved}>Impuesto ({quotePreview.tax_percent}%): ${quotePreview.tax_amount}</Text>
                      <Text style={styles.rawText}>TOTAL: ${quotePreview.total}</Text>
                      <Text style={styles.saved}>Costo directo registrado: ${quotePreview.direct_cost}</Text>
                      <Text style={styles.help}>Margen bruto estimado (no es utilidad neta): ${quotePreview.estimated_gross_margin}</Text>
                    </View>
                  )}
                  <ActionButton label="Guardar nueva versión de cotización" onPress={() => { void calculateQuote(true); }}
                    disabled={busy || !quoteOrderId || !quoteProductId || !quoteTaxConfig?.configured} />
                  <Text style={styles.subtitle}>3. Historial y aprobación</Text>
                  {quoteHistory.map(quote => (
                    <View key={quote.id} style={styles.orderRow}>
                      <Text style={styles.saved}>v{quote.version} · {quote.status} · Total ${quote.total}</Text>
                      <Text style={styles.help}>{quote.items.map(x => `${x.product_name} × ${x.quantity}`).join(', ')}</Text>
                      {quote.status === 'draft' && quote.version === (quoteHistory[0]?.version ?? 0) && (
                        <ActionButton label="Aprobar versión (propietario)" secondary
                          onPress={() => { void approveQuote(quote.id); }} disabled={busy} />
                      )}
                    </View>
                  ))}
                  <Text style={styles.help}>Los cambios de precio o impuestos generan una versión nueva: nunca sobrescriben la anterior.</Text>
                </View>
              ) : (
                <View style={styles.section}>
                  <Text style={styles.subtitle}>Buscar pedidos</Text>
                  <Text style={styles.help}>Filtra pedidos de tu empresa por estado, fecha de creación y texto.</Text>
                  <TextInput style={styles.input} value={filterText} onChangeText={setFilterText}
                    placeholder="Buscar en las solicitudes" placeholderTextColor="#94A3B8"
                    accessibilityLabel="Buscar texto" autoCorrect={false} />
                  <Text style={styles.help}>Estado del pedido</Text>
                  <View style={styles.filterWrap}>
                    {(['', 'draft', 'pending', 'confirmed', 'in_progress', 'completed', 'cancelled'] as const).map(value => (
                      <Pressable key={value || 'all'} accessibilityRole="button"
                        accessibilityLabel={`Filtrar ${value ? STATE_LABELS[value] : 'Todos'}`}
                        onPress={() => { setFilterStatus(value); setSearchPage(null); }}
                        style={[styles.filterChip, filterStatus === value && styles.filterChipActive]}>
                        <Text style={styles.filterChipText}>{value ? STATE_LABELS[value] : 'Todos'}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.help}>Fecha desde (AAAA-MM-DD)</Text>
                  <TextInput style={styles.input} value={filterFrom} onChangeText={setFilterFrom}
                    accessibilityLabel="Fecha desde" placeholder="2026-11-01"
                    placeholderTextColor="#94A3B8" autoCapitalize="none" />
                  <Text style={styles.help}>Fecha hasta (AAAA-MM-DD)</Text>
                  <TextInput style={styles.input} value={filterTo} onChangeText={setFilterTo}
                    accessibilityLabel="Fecha hasta" placeholder="2026-11-30"
                    placeholderTextColor="#94A3B8" autoCapitalize="none" />
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: filterMine }}
                    onPress={() => { setFilterMine(!filterMine); setSearchPage(null); }}>
                    <Text style={styles.link}>{filterMine ? '☑' : '☐'} Solo mis pedidos</Text>
                  </Pressable>
                  <ActionButton label="Aplicar filtros" onPress={() => { void searchOrders(0); }} disabled={busy} />
                  <ActionButton label="Limpiar filtros" onPress={clearSearch} disabled={busy} secondary />
                  {!!searchPage && (
                    <>
                      <Text style={styles.help}>
                        {searchPage.total} resultados · Página {Math.floor(searchPage.offset / searchPage.limit) + 1}
                      </Text>
                      {searchPage.items.length === 0 && <Text style={styles.notice}>Sin pedidos coincidentes.</Text>}
                      {searchPage.items.map(order => (
                        <Pressable key={order.id} accessibilityRole="button"
                          onPress={() => { setTab('review'); void openReview(order.id); }}
                          disabled={busy} style={styles.orderRow}>
                          <Text style={styles.saved}>{order.id.slice(0, 8)} · {STATE_LABELS[order.status as OrderStatus]}</Text>
                          <Text style={styles.help} numberOfLines={3}>{order.raw_text}</Text>
                          <Text style={styles.saved}>Creado: {new Date(order.created_at).toLocaleString()}</Text>
                          <Text style={styles.link}>Abrir revisión e historial</Text>
                        </Pressable>
                      ))}
                      <View style={styles.pagination}>
                        <View style={styles.pageButton}>
                          <ActionButton label="Anterior" secondary disabled={busy || searchPage.offset === 0}
                            onPress={() => { void searchOrders(Math.max(0, searchPage.offset - searchPage.limit)); }} />
                        </View>
                        <View style={styles.pageButton}>
                          <ActionButton label="Siguiente" secondary disabled={busy || !searchPage.has_more}
                            onPress={() => { if (searchPage.next_offset !== null) void searchOrders(searchPage.next_offset); }} />
                        </View>
                      </View>
                    </>
                  )}
                </View>
              )}
              <ActionButton label="Consultar mis audios" onPress={refreshNotes} disabled={busy || recorderState.isRecording} secondary />
              {savedNotes.slice(0, 10).map((note) => (
                <Text style={styles.saved} key={note.id}>
                  • {note.id.slice(0, 8)} · {note.byte_size} bytes · {new Date(note.created_at).toLocaleString()}
                </Text>
              ))}
              <ActionButton label="Cerrar sesion" onPress={logOut} disabled={busy || recorderState.isRecording} secondary />
            </View>
          )}
          {busy && <ActivityIndicator color="#5EEAD4" />}
          {!!message && <Text style={styles.message} accessibilityRole="alert">{message}</Text>}
          <Text style={styles.footer}>Los pedidos se confirman solo después de guardar la revisión humana.</Text>
          <Text style={styles.footer}>La transcripcion y extraccion automatica se integraran en una etapa posterior.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#08111F' },
  scroll: { padding: 20, paddingBottom: 48, gap: 12 },
  brand: { color: '#5EEAD4', fontSize: 16, fontWeight: '800', letterSpacing: 3 },
  heading: { color: '#F8FAFC', fontSize: 26, fontWeight: '800' },
  caption: { color: '#9EB0C5', fontSize: 13, marginBottom: 8 },
  card: { backgroundColor: '#132238', borderRadius: 20, padding: 18, gap: 12, borderWidth: 1, borderColor: '#233951' },
  subtitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  input: { borderColor: '#35506D', borderWidth: 1, borderRadius: 10, padding: 13, color: '#FFFFFF', backgroundColor: '#0C1A2B', fontSize: 15 },
  multi: { minHeight: 125, textAlignVertical: 'top' },
  button: { backgroundColor: '#5EEAD4', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginVertical: 3 },
  buttonSecondary: { backgroundColor: '#1B3953', borderWidth: 1, borderColor: '#3D5B75' },
  buttonFaded: { opacity: 0.5 },
  buttonText: { color: '#06212C', fontWeight: '800', fontSize: 15 },
  buttonTextSecondary: { color: '#D8F8F0' },
  orderRow: { padding: 12, borderRadius: 10, backgroundColor: '#142D40', gap: 4 },
  historyRow: { paddingVertical: 7, borderTopWidth: 1, borderTopColor: '#35506D', gap: 3 },
  reviewPanel: { marginTop: 12, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: '#35506D', gap: 9 },
  rawText: { color: '#EDF6FF', fontSize: 15, paddingVertical: 7 },
  link: { color: '#5EEAD4', fontWeight: '700', fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 6 },
  filterWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  filterChip: { backgroundColor: '#1A2C43', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 },
  filterChipActive: { backgroundColor: '#236C6B' },
  filterChipText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  pagination: { flexDirection: 'row', gap: 12 },
  pageButton: { flex: 1 },
  tab: { flex: 1, backgroundColor: '#1A2C43', alignItems: 'center', padding: 10, borderRadius: 9 },
  tabActive: { backgroundColor: '#236C6B' },
  tabText: { color: '#FFFFFF', fontWeight: '600', fontSize: 12 },
  section: { gap: 9 },
  help: { color: '#C4D4E4', fontSize: 13 },
  notice: { color: '#FFD8A8', fontSize: 14 },
  timer: { textAlign: 'center', fontSize: 22, fontWeight: '700', color: '#F8FAFC', padding: 10 },
  saved: { color: '#D7E5F4', fontSize: 12 },
  message: { color: '#5EEAD4', padding: 12, backgroundColor: '#153436', borderRadius: 10, fontSize: 14 },
  footer: { color: '#91A6BE', fontSize: 11, textAlign: 'center' },
});
