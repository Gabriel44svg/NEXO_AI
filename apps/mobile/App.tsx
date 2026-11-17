import React, { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView,
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

type LoginResponse = { access_token: string; token_type: string; expires_in: number };
type VoiceNote = { id: string; byte_size: number; duration_ms: number | null; created_at: string };
type DraftOrder = { id: string; status: string; raw_text: string; review_revision: number };
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
  const [tab, setTab] = useState<'voice' | 'text' | 'review'>('voice');
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
      setTab('review'); setDraftOrders([]); setActiveReview(null);
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

  async function openReview(orderId: string) {
    if (!token || busy) return;
    setBusy(true); setMessage('Cargando formulario...');
    try {
      const review = await apiRequest<OrderReview>(`/orders/${orderId}/review`, {
        method: 'GET', headers: auth,
      });
      setActiveReview(review);
      setReviewQty(review.reviewed_quantity ?? review.suggested_quantity ?? '');
      setReviewDueDate(review.reviewed_due_date ?? review.suggested_due_date ?? '');
      setMessage(review.status === 'draft'
        ? 'Corrige cantidad y fecha, guarda la revisión y después confirma.'
        : `Pedido ${review.status}: los valores confirmados son de solo lectura.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  async function saveReviewedOrder() {
    if (!activeReview || !token || busy || activeReview.status !== 'draft') return;
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
    if (!token || !activeReview || !reviewIsSaved || busy || activeReview.status !== 'draft') return;
    setBusy(true); setMessage('Confirmando el pedido...');
    try {
      const updated = await apiRequest<OrderReview>(`/orders/${activeReview.id}/confirm`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: activeReview.review_revision }),
      });
      setActiveReview(updated);
      setDraftOrders(prev => prev.map(order => order.id === updated.id
        ? { ...order, status: updated.status, review_revision: updated.review_revision } : order));
      setMessage(`Pedido ${updated.id.slice(0, 8)} CONFIRMADO con ${updated.reviewed_quantity} unidades para el ${updated.reviewed_due_date}.`);
    } catch (error) { errorMessage(error); }
    finally { setBusy(false); }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>NEXO AI</Text>
          <Text style={styles.heading}>Solicitudes inteligentes</Text>
          <Text style={styles.caption}>Captura, revision y confirmacion · RF-010</Text>

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
                  <Text style={styles.tabText}>Nota de voz</Text>
                </Pressable>
                <Pressable onPress={() => setTab('text')} style={[styles.tab, tab === 'text' && styles.tabActive]}>
                  <Text style={styles.tabText}>Texto manual</Text>
                </Pressable>
                <Pressable onPress={() => setTab('review')} style={[styles.tab, tab === 'review' && styles.tabActive]}>
                  <Text style={styles.tabText}>Revisar</Text>
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
              ) : (
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
                        editable={activeReview.status === 'draft' && !busy} />
                      <Text style={styles.help}>Fecha corregida (AAAA-MM-DD):</Text>
                      <TextInput style={styles.input} accessibilityLabel="Fecha de entrega corregida"
                        placeholder="2026-12-19" placeholderTextColor="#94A3B8" autoCapitalize="none"
                        value={reviewDueDate} onChangeText={setReviewDueDate}
                        editable={activeReview.status === 'draft' && !busy} />
                      {activeReview.status === 'draft' ? (
                        <>
                          <ActionButton label="Guardar revisión" onPress={saveReviewedOrder} disabled={busy} secondary />
                          <Text style={styles.help}>La confirmación solo usa los valores guardados, nunca la propuesta sin revisar.</Text>
                          <ActionButton label="Confirmar pedido" onPress={confirmReviewedOrder}
                            disabled={busy || !reviewIsSaved} />
                        </>
                      ) : <Text style={styles.notice}>Pedido confirmado; no admite nuevas ediciones en RF-010.</Text>}
                    </View>
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
  reviewPanel: { marginTop: 12, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: '#35506D', gap: 9 },
  rawText: { color: '#EDF6FF', fontSize: 15, paddingVertical: 7 },
  link: { color: '#5EEAD4', fontWeight: '700', fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { flex: 1, backgroundColor: '#1A2C43', alignItems: 'center', padding: 10, borderRadius: 9 },
  tabActive: { backgroundColor: '#236C6B' },
  tabText: { color: '#FFFFFF', fontWeight: '600' },
  section: { gap: 9 },
  help: { color: '#C4D4E4', fontSize: 13 },
  notice: { color: '#FFD8A8', fontSize: 14 },
  timer: { textAlign: 'center', fontSize: 22, fontWeight: '700', color: '#F8FAFC', padding: 10 },
  saved: { color: '#D7E5F4', fontSize: 12 },
  message: { color: '#5EEAD4', padding: 12, backgroundColor: '#153436', borderRadius: 10, fontSize: 14 },
  footer: { color: '#91A6BE', fontSize: 11, textAlign: 'center' },
});
