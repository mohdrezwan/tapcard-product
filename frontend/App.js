import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  StatusBar,
  Share,
  Image,
  ImageBackground,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import QRCodeLib from 'qrcode';
import Constants from 'expo-constants';

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_URL = Constants.expoConfig?.extra?.BASE_URL ?? '';
const REDIRECT_URI = typeof window !== 'undefined'
  ? window.location.origin
  : 'http://localhost:8081';
const profileKey = (email) => `tapcard_profile_${email}`;
const PHONE_RE = /^[+\d\s\-(). ]{0,20}$/;

const HONORIFICS = ['', 'Dr.', 'Prof.', 'Mr.', 'Ms.', 'Mrs.', "Dato'", 'Dato Sri', 'Tan Sri', 'Tun', 'YB'];

// ─── Themes ───────────────────────────────────────────────────────────────────
// Loaded from /api/config on mount. FALLBACK_THEME used until config arrives.
const FALLBACK_THEME = {
  id: 'default',
  name: 'Default',
  landingBg: '#0A0A0A',
  accent: '#888888',
  accentDark: '#666666',
  swatchColor: '#888888',
  corporateLayout: false,
};


// ─── Google OAuth helpers (PKCE — Authorization Code flow) ───────────────────
// PKCE eliminates implicit flow: tokens never appear in the URL.
// The code_verifier proves the request originated here; code is useless without it.

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE() {
  const verifier = base64URLEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64URLEncode(digest);
  return { verifier, challenge };
}

function buildGoogleAuthUrl(clientId, challenge) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangePKCECode(code) {
  // localStorage survives external redirects (sessionStorage is cleared in iOS PWA standalone mode)
  const raw = localStorage.getItem('pkce_verifier');
  localStorage.removeItem('pkce_verifier'); // always consume — single use
  if (!raw) throw new Error('PKCE verifier missing — please try signing in again.');
  let verifier;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.v || Date.now() - parsed.t > 10 * 60 * 1000) {
      throw new Error('Sign-in session expired — please try again.');
    }
    verifier = parsed.v;
  } catch (e) {
    if (e.message.includes('expired') || e.message.includes('verifier')) throw e;
    throw new Error('PKCE verifier corrupt — please try signing in again.');
  }
  // Exchange via backend — Web Application OAuth clients require client_secret,
  // which must never be in frontend code. Backend proxies the exchange securely.
  const res = await fetch(`${BASE_URL}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: REDIRECT_URI }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Token exchange failed.');
  }
  return res.json(); // { idToken, accessToken }
}


// Pick a photo, compress it to max 480px / JPEG 75% (~50-100KB), return base64 data URL
function pickPhoto(callback) {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new window.Image();
      img.onload = () => {
        const MAX = 480;
        let { width, height } = img;
        if (width > height) {
          if (width > MAX) { height = Math.round(height * MAX / width); width = MAX; }
        } else {
          if (height > MAX) { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', 0.75);
        img.src = '';
        callback(compressed);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// Convert ALL CAPS source data to Title Case
function toTitleCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Acronyms that must stay fully uppercase after title-casing (e.g. CEO → not Ceo)
const TITLE_ACRONYMS = new Set([
  'CEO', 'GCEO', 'DCEO', 'CIO', 'COO', 'CFO', 'CTO', 'CMO', 'CCO', 'CPO', 'CRO', 'CSO',
  'MD', 'DMD', 'GMD', 'EVP', 'SVP', 'VP', 'AVP', 'GM', 'DGM', 'AGM',
  'HR', 'IT', 'PR', 'IR', 'ICT', 'TV', 'FM', 'OTT', 'GLC', 'JV', 'R&D',
]);

function cleanTitle(str) {
  if (!str) return '';
  return toTitleCase(str)
    .trim()
    .replace(/\b[A-Za-z&]+\b/g, (w) => TITLE_ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w);
}

// Returns "Dato' Ahmad" or "Ahmad" depending on honorific
function fullName(profile) {
  if (!profile) return '';
  const h = profile.honorific ? `${profile.honorific} ` : '';
  return `${h}${profile.name}`;
}

// Fetch a remote photo URL and return it as a Base64 data URL.
// Base64 is embedded data — it bypasses all PWA standalone cookie/CORS restrictions
// that block external URLs (googleusercontent.com, storage.googleapis.com) on iOS/Android.
// When a token is supplied the backend proxy is used for Google profile pictures.
async function fetchPhotoAsBase64(url, token = null) {
  if (!url || url.startsWith('data:')) return url; // already base64
  const isGoogleUser = url.includes('googleusercontent.com');
  const isGCS = url.startsWith('https://storage.googleapis.com/');
  if (!isGoogleUser && !isGCS) return url; // not a remote photo we manage
  // Always proxy through backend when a token is available — server-side fetch has no
  // CORS restrictions, and GCS buckets don't return Access-Control-Allow-Origin by default,
  // so a direct browser fetch() is CORS-blocked even for public objects.
  if (token) {
    try {
      const res = await fetch(
        `${BASE_URL}/proxy-image?url=${encodeURIComponent(url)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.base64) return data.base64;
      }
    } catch (e) { console.warn('proxy-image fetch failed:', e.message); }
  }
  // Tokenless fallback: direct fetch (works if GCS CORS is configured, or in non-PWA contexts)
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return url; // last resort: raw URL (may fail to render on iOS PWA)
  }
}

function normaliseProfile(p, fallbackPhoto = null) {
  return {
    ...p,
    name: p.name || '',
    title: p.title || '',
    dept: p.dept || '',
    photo: p.photo || fallbackPhoto || null,
  };
}

async function persistProfile(email, userData, profileData, token) {
  await Promise.all([
    AsyncStorage.setItem('tapcard_last_email', email),
    AsyncStorage.setItem(profileKey(email), JSON.stringify({ user: userData, profile: profileData })),
    AsyncStorage.setItem('tapcard_session_verified_at', Date.now().toString()),
  ]);
  if (token) {
    fetch(`${BASE_URL}/profile/${encodeURIComponent(email)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(profileData),
    }).catch(e => console.warn('profile sync failed:', e.message));
  }
}

// ─── Theme ───────────────────────────────────────────────────────────────────
const COLORS = {
  primary: '#B09050',
  primaryDark: '#8C7040',
  primaryLight: '#C8AB6E',
  background: '#F2EDE6',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#888888',
  border: '#E5DDD0',
  error: '#EF4444',
};

// ─── PWA setup (runs once on load) ───────────────────────────────────────────
if (typeof window !== 'undefined') {
  // Register service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}


function isInStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
}

// iOS "Add to Home Screen" nudge banner
function InstallBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIOS() || isInStandaloneMode()) return;
    AsyncStorage.getItem('tapcard_install_dismissed').then(v => {
      if (!v) setVisible(true);
    });
  }, []);

  if (!visible) return null;

  function dismiss() {
    AsyncStorage.setItem('tapcard_install_dismissed', '1');
    setVisible(false);
  }

  return (
    <View style={installStyles.banner}>
      <View style={installStyles.row}>
        <Text style={installStyles.text}>
          Install Digital Card: tap{' '}
          <Text style={installStyles.bold}>Share</Text>
          {' '}then{' '}
          <Text style={installStyles.bold}>"Add to Home Screen"</Text>
        </Text>
        <TouchableOpacity onPress={dismiss} style={installStyles.close}>
          <Text style={installStyles.closeText}>✕</Text>
        </TouchableOpacity>
      </View>
      <View style={installStyles.arrow} />
    </View>
  );
}

const installStyles = StyleSheet.create({
  banner: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    padding: 16,
    zIndex: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  bold: {
    fontWeight: '700',
    color: '#C8AB6E',
  },
  close: {
    marginLeft: 12,
    padding: 4,
  },
  closeText: {
    color: '#888',
    fontSize: 16,
  },
  arrow: {
    position: 'absolute',
    bottom: -8,
    alignSelf: 'center',
    width: 16,
    height: 16,
    backgroundColor: '#1A1A1A',
    transform: [{ rotate: '45deg' }],
    borderRadius: 2,
  },
});

// ─── Screens ──────────────────────────────────────────────────────────────────
const SCREEN = {
  LOGIN: 'LOGIN',
  PROFILE_SETUP: 'PROFILE_SETUP',
  CARD_DISPLAY: 'CARD_DISPLAY',
  CARD_VIEW: 'CARD_VIEW',
  EDIT_PROFILE: 'EDIT_PROFILE',
};

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState(SCREEN.LOGIN);
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [themes, setThemes] = useState([FALLBACK_THEME]);
  const [clientId, setClientId] = useState(null);
  const [theme, setTheme] = useState(FALLBACK_THEME);
  const idTokenRef = useRef(null);
  const tokenExpiryRef = useRef(0);
  useEffect(() => {
    // Fetch config (themes + clientId), then restore saved theme
    fetch('/api/config', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.resolve(null))
      .then(cfg => {
        const loaded = cfg?.themes?.length ? cfg.themes : null;
        if (loaded) setThemes(loaded);
        if (cfg?.oauthClientId) setClientId(cfg.oauthClientId);
        return AsyncStorage.getItem('tapcard_theme').then(id => {
          const list = loaded || [FALLBACK_THEME];
          setTheme(list.find(t => t.id === id) || list[0]);
        });
      })
      .catch(() => {});

    // PKCE redirect: Google returns ?code=... in query string (not hash)
    if (typeof window !== 'undefined') {
      const queryParams = new URLSearchParams(window.location.search);
      const code = queryParams.get('code');
      if (code) {
        // Clear code from URL immediately before any async work
        window.history.replaceState(null, '', window.location.pathname);
        exchangePKCECode(code)
          .then(tokens => verifyWithBackend(tokens.idToken, tokens.accessToken || null))
          .catch(err => {
            Alert.alert('Auth Error', err.message || 'Sign in failed. Please try again.');
            setLoading(false);
          });
        return;
      }
    }

    restoreSession();
  }, []);

  async function restoreSession() {
    const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
    try {
      const lastEmail = await AsyncStorage.getItem('tapcard_last_email');
      if (lastEmail) {
        // SEC-4: enforce session TTL — expired sessions require re-authentication
        const verifiedAt = await AsyncStorage.getItem('tapcard_session_verified_at');
        if (!verifiedAt || Date.now() - parseInt(verifiedAt, 10) > SESSION_TTL_MS) {
          await AsyncStorage.multiRemove([
            'tapcard_last_email',
            profileKey(lastEmail),
            'tapcard_session_verified_at',
          ]);
          return; // force login
        }

        const storedToken = await AsyncStorage.getItem('tapcard_id_token');
        const storedExpiry = parseInt(await AsyncStorage.getItem('tapcard_token_expiry') || '0', 10);
        if (storedToken && Date.now() < storedExpiry - 5 * 60 * 1000) {
          idTokenRef.current = storedToken;
          tokenExpiryRef.current = storedExpiry;
        }

        const stored = await AsyncStorage.getItem(profileKey(lastEmail));
        if (stored) {
          const data = JSON.parse(stored);
          const normalised = normaliseProfile(data.profile, data.user?.picture);
          // Convert any stored Google URL to Base64 so it displays in PWA standalone mode
          normalised.photo = await fetchPhotoAsBase64(normalised.photo);
          // Persist the Base64 photo so future restores don't need to re-fetch
          if (data.profile.photo !== normalised.photo) {
            await AsyncStorage.setItem(profileKey(lastEmail), JSON.stringify({ user: data.user, profile: normalised }));
          }
          setUser(data.user);
          setProfile(normalised);
          setScreen(SCREEN.CARD_DISPLAY);
          return;
        }
        // SEC-3: local cache missing and no valid token available — require re-authentication.
        // Removed unauthenticated /profile/:email fetch that leaked employee data.
      }
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function verifyWithBackend(token, accessToken = null) {
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        Alert.alert(
          'Access Denied',
          data.error || 'Your account is not authorised.'
        );
        return;
      }

      idTokenRef.current = token;
      tokenExpiryRef.current = Date.now() + 3600000;
      AsyncStorage.setItem('tapcard_id_token', token);
      AsyncStorage.setItem('tapcard_token_expiry', tokenExpiryRef.current.toString());

      // Fetch photo via access_token — more reliable than id_token picture claim
      // for Google Workspace accounts where the picture attribute may be restricted
      let picture = data.picture || null;
      if (!picture && accessToken) {
        try {
          const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (uiRes.ok) picture = (await uiRes.json()).picture || null;
        } catch (e) { console.warn('userinfo fetch failed:', e.message); }
      }
      const photoCache = new Map();
      async function cachedPhotoFetch(url) {
        if (!url || url.startsWith('data:')) return url;
        if (photoCache.has(url)) return photoCache.get(url);
        const base64 = await fetchPhotoAsBase64(url, token);
        photoCache.set(url, base64);
        return base64;
      }

      picture = await cachedPhotoFetch(picture);

      const googleUser = {
        email: data['Email'] || data.email,
        name: toTitleCase(data['Employee Name'] || data.name),
        picture,
      };
      setUser(googleUser);

      // Existing profile in local cache
      const stored = await AsyncStorage.getItem(profileKey(googleUser.email));
      if (stored) {
        const p = JSON.parse(stored).profile;
        const normalised = normaliseProfile(p, googleUser.picture);
        if (normalised.photo && !normalised.photo.startsWith('data:')) {
          normalised.photo = await cachedPhotoFetch(normalised.photo);
        }
        if (!p.photo && normalised.photo) {
          await persistProfile(googleUser.email, googleUser, normalised, token);
        }
        setProfile(normalised);
        setScreen(SCREEN.CARD_DISPLAY);
        return;
      }

      // No local cache — try Firestore (cross-device restore)
      try {
        const profileRes = await fetch(`${BASE_URL}/profile/${encodeURIComponent(googleUser.email)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (profileRes.ok) {
          const p = await profileRes.json();
          const normalised = normaliseProfile(p, googleUser.picture);
          if (normalised.photo && !normalised.photo.startsWith('data:')) {
            normalised.photo = await cachedPhotoFetch(normalised.photo);
          }
          await persistProfile(googleUser.email, googleUser, normalised, p.photo ? null : token);
          setProfile(normalised);
          setScreen(SCREEN.CARD_DISPLAY);
          return;
        }
      } catch (e) { console.warn('profile fetch failed:', e.message); }

      // New user — send to profile setup
      setProfile({
        name: toTitleCase(data['Employee Name'] || ''),
        title: cleanTitle(data['Position Title'] || ''),
        dept: toTitleCase(data['BusinessUnit'] || ''),
        phone: data['work_phone'] || '',
        email: data['Email'] || '',
        honorific: '',
        photo: picture,
      });
      setScreen(SCREEN.PROFILE_SETUP);
    } catch (err) {
      Alert.alert('Network Error', err.message || 'Could not reach server.');
    } finally {
      setLoading(false);
    }
  }

  // Upload base64 photo to Cloud Storage; returns GCS URL (or original if already a URL)
  async function uploadPhotoIfNeeded(photo, email, token) {
    if (!photo || !photo.startsWith('data:')) return photo; // already a URL or null
    try {
      const res = await fetch(`${BASE_URL}/profile/${encodeURIComponent(email)}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ photoBase64: photo }),
      });
      if (res.ok) {
        const { url } = await res.json();
        return url;
      }
    } catch (e) { console.warn('photo upload failed:', e.message); }
    return photo; // fall back to base64 on network error
  }

  async function saveProfile(profileData) {
    const TOKEN_BUFFER_MS = 5 * 60 * 1000;
    if (!idTokenRef.current || Date.now() > tokenExpiryRef.current - TOKEN_BUFFER_MS) {
      Alert.alert('Session Expired', 'Your session has expired. Please sign in again.');
      handleSignOut();
      return;
    }
    let finalData = { ...profileData, theme: theme.id };
    if (idTokenRef.current && finalData.photo?.startsWith('data:')) {
      finalData.photo = await uploadPhotoIfNeeded(finalData.photo, finalData.email, idTokenRef.current);
    }
    // Persist GCS URL to Firestore + localStorage (canonical form)
    await persistProfile(finalData.email, user, finalData, idTokenRef.current);
    // Convert GCS URL → base64 for display — iOS PWA can't render raw GCS URLs in <Image>
    const displayProfile = { ...finalData };
    if (displayProfile.photo && !displayProfile.photo.startsWith('data:')) {
      displayProfile.photo = await fetchPhotoAsBase64(displayProfile.photo, idTokenRef.current);
    }
    setProfile(displayProfile);
    setScreen(SCREEN.CARD_VIEW);
  }

  async function handleThemeChange(newTheme) {
    setTheme(newTheme);
    await AsyncStorage.setItem('tapcard_theme', newTheme.id);
    if (user?.email && idTokenRef.current) {
      fetch(`${BASE_URL}/profile/${encodeURIComponent(user.email)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idTokenRef.current}` },
        body: JSON.stringify({ theme: newTheme.id }),
      }).catch(() => {});
    }
  }

  async function handleSignOut() {
    // Clear local storage on sign-out — prevents session persistence on shared devices
    const email = user?.email;
    if (email) {
      await AsyncStorage.removeItem('tapcard_last_email');
      await AsyncStorage.removeItem(profileKey(email));
    }
    idTokenRef.current = null;
    tokenExpiryRef.current = 0;
    AsyncStorage.removeItem('tapcard_id_token');
    AsyncStorage.removeItem('tapcard_token_expiry');
    setUser(null);
    setProfile(null);
    setScreen(SCREEN.LOGIN);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  async function handleSignIn() {
    if (!clientId) return;
    const { verifier, challenge } = await generatePKCE();
    // Store in localStorage with timestamp — survives iOS PWA external redirects
    localStorage.setItem('pkce_verifier', JSON.stringify({ v: verifier, t: Date.now() }));
    window.location.href = buildGoogleAuthUrl(clientId, challenge);
  }

  let content = null;
  switch (screen) {
    case SCREEN.LOGIN:
      content = <LoginScreen onSignIn={handleSignIn} disabled={!clientId} />;
      break;
    case SCREEN.PROFILE_SETUP:
      content = <ProfileSetupScreen user={user} profile={profile} onSave={saveProfile} />;
      break;
    case SCREEN.CARD_DISPLAY:
      content = (
        <GoldCardView
          profile={profile}
          user={user}
          theme={theme}
          onBack={null}
          onSettings={() => setScreen(SCREEN.CARD_VIEW)}
        />
      );
      break;
    case SCREEN.CARD_VIEW:
      content = (
        <CardViewScreen
          user={user}
          profile={profile}
          onEdit={() => setScreen(SCREEN.EDIT_PROFILE)}
          onSignOut={handleSignOut}
          theme={theme}
          onThemeChange={handleThemeChange}
          onBack={() => setScreen(SCREEN.CARD_DISPLAY)}
        />
      );
      break;
    case SCREEN.EDIT_PROFILE:
      content = (
        <EditProfileScreen
          user={user}
          profile={profile}
          onSave={saveProfile}
          onCancel={() => setScreen(SCREEN.CARD_VIEW)}
          theme={theme}
          onThemeChange={handleThemeChange}
          themes={themes}
        />
      );
      break;
    default:
      return null;
  }

  return (
    <View style={{ flex: 1 }}>
      {content}
      <InstallBanner />
    </View>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onSignIn, disabled }) {
  return (
    <ImageBackground
      source={{ uri: '/loginbg.png' }}
      style={styles.loginContainer}
      resizeMode="cover"
    >
      <StatusBar barStyle="dark-content" />

      {/* Hero area */}
      <View style={styles.loginHero}>
        <View style={styles.loginHeroCard}>
          <Text style={styles.heroTitle}>DIGITAL BUSINESS CARD</Text>
        </View>
      </View>

      {/* Bottom sign-in panel */}
      <View style={styles.loginCard}>
        <Text style={styles.loginHeading}>Welcome</Text>
        <Text style={styles.loginBody}>
          Sign in with Google to access your digital business card.
        </Text>

        <TouchableOpacity
          style={[styles.googleButton, disabled && styles.buttonDisabled]}
          onPress={disabled ? undefined : onSignIn}
          disabled={!!disabled}
        >
          <Text style={styles.googleIcon}>G</Text>
          <Text style={styles.googleButtonText}>Sign in with Google</Text>
        </TouchableOpacity>
      </View>
    </ImageBackground>
  );
}

// ─── Card View Screen ─────────────────────────────────────────────────────────
function CardViewScreen({ user, profile, onEdit, onSignOut, theme, onThemeChange, onBack }) {
  const avatarSource = profile?.photo || user?.picture;
  const textColor = theme.landingDark ? '#FFFFFF' : COLORS.text;
  const textLightColor = theme.landingDark ? 'rgba(255,255,255,0.6)' : COLORS.textLight;

  function handleSaveContact() {
    const vcard = buildVCard(profile);
    if (typeof document !== 'undefined') {
      const blob = new Blob([vcard], { type: 'text/vcard;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(profile.name || 'contact').replace(/\s+/g, '_')}.vcf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  async function handleShareApp() {
    try {
      await navigator.share({
        title: 'Digital Business Card',
        text: 'Create your digital business card',
        url: window.location.origin,
      });
    } catch (e) {
      // user cancelled
    }
  }

  function openLink(url) {
    if (typeof window === 'undefined') return;
    if (/^https:\/\//.test(url)) {
      window.location.href = url;
    } else if (/^mailto:/.test(url)) {
      window.location.href = url;
    } else if (/^tel:/.test(url)) {
      // SEC-7: strip non-numeric chars to prevent URI injection via user-supplied phone data
      const sanitized = url.slice(4).replace(/[^+\d\s\-(). ]/g, '');
      if (sanitized) window.location.href = `tel:${sanitized}`;
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.landingBg }}>
      {theme.landingImage && (
        <ImageBackground source={theme.landingImage} style={StyleSheet.absoluteFill} resizeMode="cover" />
      )}
      <StatusBar
        barStyle={theme.landingDark ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
      />
      <ScrollView contentContainerStyle={styles.profileScrollContent}>

        {/* Top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onBack} style={styles.cardViewBackBtn} accessibilityLabel="Back to card">
            <Text style={[styles.cardViewBackBtnText, { color: textColor }]}>←</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.shareHeaderBtn, theme.landingDark && { backgroundColor: 'rgba(255,255,255,0.15)' }]}
            onPress={handleShareApp}
          >
            <Text style={styles.shareHeaderBtnText}>⬆  Share App</Text>
          </TouchableOpacity>
        </View>

        {/* Floating avatar + white contact card */}
        <View style={styles.floatingCardContainer}>
          <View style={[styles.floatingAvatarRing, { borderColor: theme.landingBg }]}>
            {avatarSource ? (
              <Image source={{ uri: avatarSource }} style={styles.floatingAvatar} />
            ) : (
              <View style={[styles.floatingAvatar, styles.floatingAvatarPlaceholder]}>
                <Text style={styles.floatingAvatarInitial}>
                  {(profile.name || '?')[0].toUpperCase()}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.contactCard}>
            <Text style={styles.contactName}>{fullName(profile)}</Text>
            <Text style={styles.contactJobTitle}>{profile.title}</Text>

            <View style={styles.contactDivider} />

            {profile.phone ? (
              <TouchableOpacity onPress={() => openLink(`tel:${profile.phone}`)}>
                <Text style={styles.contactLink}>{profile.phone}</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity onPress={() => openLink(`mailto:${profile.email}`)}>
              <Text style={styles.contactLink}>{profile.email}</Text>
            </TouchableOpacity>

            <View style={styles.contactDivider} />

            <View style={styles.contactCompanyRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.contactCompanyName}>{theme.subsidiary?.companyName || ''}</Text>
                {theme.subsidiary?.website ? (
                  <TouchableOpacity onPress={() => openLink(`https://${theme.subsidiary.website}`)}>
                    <Text style={styles.contactWebsite}>{theme.subsidiary.website}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </View>
        </View>

        {/* Action buttons */}
        <TouchableOpacity style={[styles.goldButton, styles.goldButtonOutline, { borderColor: theme.accent, backgroundColor: 'rgba(255,255,255,0.88)' }]} onPress={handleSaveContact}>
          <Text style={[styles.goldButtonOutlineText, { color: theme.accent }]}>Save my contact</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.goldButton, styles.goldButtonOutline, { borderColor: theme.accent, marginTop: 12, backgroundColor: 'rgba(255,255,255,0.88)' }]} onPress={onBack}>
          <Text style={[styles.goldButtonOutlineText, { color: theme.accent }]}>View my card</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.goldButton, styles.goldButtonOutline, { borderColor: theme.accent, marginTop: 12, backgroundColor: 'rgba(255,255,255,0.88)' }]} onPress={onEdit}>
          <Text style={[styles.goldButtonOutlineText, { color: theme.accent }]}>Edit Card</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.goldButton, styles.goldButtonOutline, { borderColor: theme.accent, marginTop: 12, backgroundColor: 'rgba(255,255,255,0.88)' }]} onPress={onSignOut}>
          <Text style={[styles.goldButtonOutlineText, { color: theme.accent }]}>Sign Out</Text>
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}

// ─── Gold Card View ───────────────────────────────────────────────────────────
function GoldCardView({ profile, user, theme, onBack, onEdit, onSettings }) {
  const avatarSource = profile?.photo || user?.picture;
  const companyName = theme.subsidiary?.companyName || '';
  const cardRef = useRef(null);
  // QR code gets plain vCard (no photo — QR has ~3KB limit)
  const vcardStringForQR = buildVCard(profile, { companyName });
  // Share file gets full vCard with embedded photo for offline contact saving
  const vcardStringForShare = buildVCard(profile, { companyName, photoBase64: avatarSource });

  async function captureCardPng() {
    try {
      if (!cardRef.current) return null;
      const { default: html2canvas } = await import('html2canvas');
      const rect = cardRef.current.getBoundingClientRect();
      // Include background visible around the card (matches app view)
      const pad = 40;
      const canvas = await html2canvas(document.documentElement, {
        useCORS: true,
        allowTaint: false,
        scale: 2,
        x: Math.max(0, rect.left - pad),
        y: Math.max(0, rect.top - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        logging: false,
        backgroundColor: null,
      });
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.split(',')[1];
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return new Blob([bytes], { type: 'image/png' });
    } catch (err) {
      console.error('[captureCardPng] failed:', err);
      return null;
    }
  }

  async function shareViaWhatsApp() {
    const baseName = (profile.name || 'contact').replace(/\s+/g, '_');
    const vcardUrl = `${window.location.origin}/vcard.html?e=${encodeURIComponent((profile.email || '').toLowerCase())}`;
    const shareText = `Save my contact: ${vcardUrl}`;

    if (navigator.share) {
      const pngBlob = await captureCardPng();
      if (pngBlob) {
        const pngFile = new File([pngBlob], `${baseName}.png`, { type: 'image/png' });
        // PNG only — WhatsApp drops PNG when VCF included; send link to save contact instead
        try {
          await navigator.share({ files: [pngFile], text: shareText, title: fullName(profile) });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      // PNG failed — text+URL only
      try {
        await navigator.share({ title: fullName(profile), text: shareText });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }

    // Last resort: download VCF
    const vcfBlob = new Blob([vcardStringForShare], { type: 'text/vcard' });
    const url = URL.createObjectURL(vcfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.vcf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Corporate white card layout ───────────────────────────────────────────
  if (theme.corporateLayout) {
    const sub = theme.subsidiary || {};
    const cardBg = theme.cardBgColor ?? (theme.darkCard ? '#1A1A1A' : '#FFFFFF');
    const cardTextPrimary = theme.darkCard ? '#FFFFFF' : '#333333';
    const cardTextSecondary = theme.darkCard ? '#AAAAAA' : '#888888';
    const cardDividerColor = theme.darkCard ? '#333333' : '#E8E8E8';
    const cardAccent = theme.accent;
    const cardWebsiteColor = theme.accent;
    const cardQrBg = theme.darkCard ? '#1A1A1A' : '#FFFFFF';
    const cardQrFg = theme.darkCard ? '#FFFFFF' : '#1A1A1A';
    const cardQrBorder = theme.darkCard ? '#333333' : '#E8E8E8';

    // paddingTop: 0 is a valid override — use !== undefined, not ??, to preserve 0
    const cardContent = (
      <View style={[corpStyles.cardContent, theme.cardContentPaddingTop !== undefined && { paddingTop: theme.cardContentPaddingTop }]}>
        {theme.logoImage ? (
          <Image source={theme.logoImage} style={{ width: theme.logoWidth ?? '100%', height: undefined, aspectRatio: theme.logoAspectRatio ?? (402 / 107), marginBottom: theme.logoMarginBottom ?? 16, alignSelf: theme.logoWidth ? 'flex-start' : 'stretch' }} resizeMode="contain" />
        ) : (
          <>
            <View style={{ alignSelf: 'flex-start', overflow: 'hidden', width: 258, height: 85 }}>
              <Image source={{ uri: '/logos/Media_Prima.png' }} style={{ width: 350, height: 85, marginLeft: -106 }} resizeMode="contain" />
            </View>
            <View style={{ height: 12 }} />
          </>
        )}

        <Text style={[corpStyles.name, { color: cardAccent }]}>{fullName(profile)}</Text>
        <Text style={[corpStyles.title, { color: cardTextPrimary }]}>{profile.title}</Text>
        {profile.dept ? <Text style={[corpStyles.title, { color: cardTextPrimary }]}>{profile.dept}</Text> : null}

        <View style={[corpStyles.divider, { backgroundColor: cardDividerColor }]} />

        <Text style={[corpStyles.email, { color: cardTextPrimary }]}>{profile.email}</Text>
        {profile.phone ? (
          <Text style={[corpStyles.phone, { color: cardAccent }]}>HP: {profile.phone}</Text>
        ) : null}

        <View style={[corpStyles.divider, { backgroundColor: cardDividerColor }]} />

        <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
          <View style={{ flex: 1 }}>
            <Text style={[corpStyles.companyName, { color: cardTextPrimary, marginBottom: 1 }]} numberOfLines={1}>{sub.companyName}</Text>
            {sub.companyReg ? <Text style={[corpStyles.address, { color: cardTextSecondary, fontSize: 9, opacity: 0.65, lineHeight: 13, marginBottom: 2 }]}>{sub.companyReg}</Text> : null}
            {(sub.addressLines || []).map((line, i) => (
              <Text key={i} style={[corpStyles.address, { color: cardTextSecondary }]}>{line}</Text>
            ))}
            {sub.website ? <Text style={[corpStyles.website, { color: cardWebsiteColor }]}>{sub.website}</Text> : null}

            <View style={{ height: 12 }} />

            <View style={[corpStyles.qrBox, { backgroundColor: cardQrBg, borderColor: cardQrBorder }]}>
              <QRCode
                value={vcardStringForQR}
                size={theme.qrSize ?? 120}
                color={cardQrFg}
                backgroundColor={cardQrBg}
              />
            </View>
          </View>

          {theme.inlineStrip && theme.sideStripImage?.uri && (
            <View style={{
              width: theme.inlineStripWidth ?? 88,
              alignSelf: 'stretch',
              marginLeft: 8,
              backgroundImage: `url(${theme.sideStripImage.uri})`,
              backgroundSize: '100% auto',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: theme.sideStripPosition ?? 'top center',
            }} />
          )}
        </View>

        {theme.bottomLogoImage && (
          <Image source={theme.bottomLogoImage} style={{ width: '100%', height: undefined, aspectRatio: theme.bottomLogoAspectRatio ?? 4, marginTop: 12 }} resizeMode="contain" />
        )}
      </View>
    );

    // paddingTop: 0 is a valid override — use !== undefined, not ??, to preserve 0
    const cardWrapperStyle = [
      corpStyles.cardWrapper,
      { backgroundColor: cardBg },
      theme.cardWrapperPaddingTop !== undefined && { paddingTop: theme.cardWrapperPaddingTop },
      theme.cardImage?.uri && {
        backgroundImage: `url(${theme.cardImage.uri})`,
        backgroundSize: theme.cardImageSize ?? 'cover',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: theme.cardImagePosition ?? 'center',
        ...(theme.cardImageBlendMode && { backgroundBlendMode: theme.cardImageBlendMode }),
      },
    ];

    return (
      <View style={{ flex: 1, backgroundColor: theme.cardViewBg ?? theme.landingBg ?? '#F5F5F5' }}>
        {!theme.cardViewBg && theme.landingImage && (
          <ImageBackground source={theme.landingImage} style={StyleSheet.absoluteFill} resizeMode="cover" />
        )}
        <StatusBar barStyle={theme.landingDark ? 'light-content' : 'dark-content'} backgroundColor="transparent" />
        <ScrollView contentContainerStyle={[styles.goldScrollContent, { paddingTop: Platform.OS === 'ios' ? 56 : 36, flexGrow: 1, justifyContent: 'space-between' }]}>

          <View>
            {onBack && (
              <TouchableOpacity style={[styles.backBtn, { backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, alignSelf: 'flex-start', marginTop: -20 }]} onPress={onBack}>
                <Text style={[styles.backBtnText, { color: '#333333', fontSize: 13 }]}>← Back</Text>
              </TouchableOpacity>
            )}

            {onSettings && (
              <View style={styles.gearFloatRow}>
                <TouchableOpacity style={styles.gearBtn} onPress={onSettings} accessibilityLabel="Settings">
                  <Text style={styles.gearBtnText}>⚙</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Card wrapper */}
            <View style={styles.cardWrapperOuter}>
              <View ref={cardRef} style={cardWrapperStyle}>
                {cardContent}
                {theme.hasSideStrip && theme.sideStripImage?.uri && (
                  <View style={[corpStyles.sideStrip, theme.sideStripWidth && { width: theme.sideStripWidth }, { backgroundImage: `url(${theme.sideStripImage.uri})`, backgroundSize: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' }]} />
                )}
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.whatsappBtn, corpStyles.shareBtn, { marginTop: 16, marginBottom: 8, borderColor: theme.darkCard ? '#444' : '#DDDDDD', backgroundColor: theme.darkCard ? '#2A2A2A' : '#FFFFFF' }]}
            onPress={shareViaWhatsApp}
          >
            <Text style={[styles.whatsappBtnText, { color: theme.darkCard ? '#FFFFFF' : '#1A1A1A' }]}>Share Contact</Text>
          </TouchableOpacity>

        </ScrollView>
      </View>
    );
  }

  // ── Standard coloured card layout ─────────────────────────────────────────
  const viewBg = theme.viewBg ?? theme.landingBg;
  return (
    <View style={{ flex: 1, backgroundColor: viewBg }}>
      <StatusBar barStyle="light-content" backgroundColor={viewBg} />
      <ScrollView contentContainerStyle={styles.goldScrollContent}>

        {onBack && (
          <TouchableOpacity style={styles.backBtn} onPress={onBack}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
        )}

        {onSettings && (
          <View style={styles.gearFloatRow}>
            <TouchableOpacity style={styles.gearBtn} onPress={onSettings} accessibilityLabel="Settings">
              <Text style={styles.gearBtnText}>⚙</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.goldCardOuter}>
          <View ref={cardRef} style={[styles.goldCard, { backgroundColor: viewBg }]}>
            <View style={styles.goldCardTopRow}>
              {avatarSource ? (
                <Image source={{ uri: avatarSource }} style={styles.goldCardAvatar} />
              ) : (
                <View style={[styles.goldCardAvatar, styles.goldCardAvatarPlaceholder]}>
                  <Text style={styles.goldCardAvatarInitial}>
                    {(profile.name || '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
            </View>

            <Text style={styles.goldCardJobTitle}>{profile.title}</Text>
            <Text style={styles.goldCardName}>{fullName(profile)}</Text>
            {profile.dept ? <Text style={styles.goldCardDept}>{profile.dept}</Text> : null}

            <View style={{ height: 28 }} />

            {profile.phone ? (
              <View style={styles.goldCardField}>
                <Text style={styles.goldCardFieldLabel}>PHONE</Text>
                <Text style={styles.goldCardFieldValue}>{profile.phone}</Text>
              </View>
            ) : null}

            <View style={styles.goldCardField}>
              <Text style={styles.goldCardFieldLabel}>EMAIL</Text>
              <Text style={styles.goldCardFieldValue}>{profile.email}</Text>
            </View>

            <View style={{ height: 28 }} />

            <View style={styles.goldCardQRBox}>
              <QRCode
                value={vcardStringForQR}
                size={160}
                color={COLORS.text}
                backgroundColor="#FFFFFF"
              />
            </View>
          </View>

        </View>

        <TouchableOpacity style={styles.whatsappBtn} onPress={shareViaWhatsApp}>
          <Text style={styles.whatsappBtnText}>Share Contact</Text>
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}

// ─── Profile Setup Screen ─────────────────────────────────────────────────────
function ProfileSetupScreen({ user, profile, onSave }) {
  const [form, setForm] = useState({
    name: profile?.name || user?.name || '',
    title: profile?.title || '',
    dept: profile?.dept || '',
    phone: profile?.phone || '',
    honorific: profile?.honorific || '',
    photo: profile?.photo || null,
  });
  const [saving, setSaving] = useState(false);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handlePickPhoto() {
    pickPhoto((dataUrl) => update('photo', dataUrl));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.title.trim()) {
      Alert.alert('Required', 'Please enter at least your name and job title.');
      return;
    }
    if (form.phone && !PHONE_RE.test(form.phone)) {
      Alert.alert('Invalid Phone', 'Please enter a valid phone number (digits, spaces, +, -, () only).');
      return;
    }
    setSaving(true);
    await onSave({ ...form, email: user.email });
    setSaving(false);
  }

  const avatarSource = form.photo || user?.picture;

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />
      <ScrollView contentContainerStyle={styles.formScrollContent}>

        <View style={styles.formHeader}>
          <Text style={styles.formHeaderTitle}>Set Up Your Card</Text>
          <Text style={styles.formHeaderSubtitle}>
            This info will appear on your digital business card.
          </Text>
        </View>

        {/* Tappable avatar */}
        <AvatarPicker avatarSource={avatarSource} name={form.name} onPress={handlePickPhoto} />

        <Text style={styles.emailTag}>{user?.email}</Text>

        {/* Honorific selector */}
        <View style={styles.formCard}>
          <Text style={styles.fieldLabel}>Honorific</Text>
          <HonorificsSelector value={form.honorific} onChange={(v) => update('honorific', v)} />
        </View>

        <View style={styles.formCard}>
          <FormField label="Full Name *" value={form.name} onChangeText={(v) => update('name', v)} placeholder="e.g. Ahmad Razif" maxLength={80} />
          <FormField label="Job Title *" value={form.title} onChangeText={(v) => update('title', v)} placeholder="e.g. Senior Producer" maxLength={100} />
          <FormField label="Department" value={form.dept} onChangeText={(v) => update('dept', v)} placeholder="e.g. Digital Media" maxLength={100} />
          <FormField label="Phone Number" value={form.phone} onChangeText={(v) => update('phone', v)} placeholder="e.g. +60 12-345 6789" keyboardType="phone-pad" maxLength={20} />
        </View>

        <TouchableOpacity
          style={[styles.goldButton, saving && styles.buttonDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.goldButtonText}>Create My Card</Text>}
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}

// ─── Edit Profile Screen ──────────────────────────────────────────────────────
function EditProfileScreen({ user, profile, onSave, onCancel, theme, onThemeChange, themes }) {
  const [form, setForm] = useState({
    ...profile,
    honorific: profile?.honorific || '',
    photo: profile?.photo || null,
  });
  const [saving, setSaving] = useState(false);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handlePickPhoto() {
    pickPhoto((dataUrl) => update('photo', dataUrl));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.title.trim()) {
      Alert.alert('Required', 'Name and job title cannot be empty.');
      return;
    }
    if (form.phone && !PHONE_RE.test(form.phone)) {
      Alert.alert('Invalid Phone', 'Please enter a valid phone number (digits, spaces, +, -, () only).');
      return;
    }
    setSaving(true);
    await onSave(form);
    setSaving(false);
  }

  const avatarSource = form.photo || user?.picture;
  const textColor = theme.landingDark ? '#FFFFFF' : COLORS.text;
  const textLightColor = theme.landingDark ? 'rgba(255,255,255,0.6)' : COLORS.textLight;

  return (
    <View style={{ flex: 1, backgroundColor: theme.landingBg }}>
      {theme.landingImage && (
        <ImageBackground source={theme.landingImage} style={StyleSheet.absoluteFill} resizeMode="cover" />
      )}
      <StatusBar
        barStyle={theme.landingDark ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
      />
      <ScrollView contentContainerStyle={styles.formScrollContent}>

        <View style={[styles.formHeader, theme.landingImage && { backgroundColor: theme.landingDark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.75)', borderRadius: 10, padding: 12 }]}>
          <Text style={[styles.formHeaderTitle, { color: textColor }]}>Edit Card</Text>
          <Text style={[styles.formHeaderSubtitle, { color: textLightColor }]}>{user?.email}</Text>
        </View>

        {/* Tappable avatar */}
        <AvatarPicker avatarSource={avatarSource} name={form.name} onPress={handlePickPhoto} />

        {/* Honorific selector */}
        <View style={styles.formCard}>
          <Text style={[styles.fieldLabel, { color: textLightColor }]}>Honorific</Text>
          <HonorificsSelector value={form.honorific} onChange={(v) => update('honorific', v)} accent={theme.accent} />
        </View>

        <View style={styles.formCard}>
          <FormField label="Full Name *" value={form.name} onChangeText={(v) => update('name', v)} accent={theme.accent} maxLength={80} />
          <FormField label="Job Title *" value={form.title} onChangeText={(v) => update('title', v)} accent={theme.accent} maxLength={100} />
          <FormField label="Department" value={form.dept} onChangeText={(v) => update('dept', v)} accent={theme.accent} maxLength={100} />
          <FormField label="Phone Number" value={form.phone} onChangeText={(v) => update('phone', v)} keyboardType="phone-pad" accent={theme.accent} maxLength={20} />
        </View>

        <ThemePicker themes={themes} currentTheme={theme} onSelect={onThemeChange} labelColor={textLightColor} />

        <View style={[styles.editActionRow, { marginTop: 16 }]}>
          <TouchableOpacity style={[styles.goldButton, styles.goldButtonOutline, { flex: 1, borderColor: theme.accent, backgroundColor: 'rgba(255,255,255,0.88)' }]} onPress={onCancel}>
            <Text style={[styles.goldButtonOutlineText, { color: theme.accent }]}>Cancel</Text>
          </TouchableOpacity>
          <View style={{ width: 12 }} />
          <TouchableOpacity
            style={[styles.goldButton, { flex: 1, backgroundColor: theme.landingDark ? 'rgba(255,255,255,0.88)' : theme.accent }, saving && styles.buttonDisabled]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color={theme.accent} /> : <Text style={[styles.goldButtonText, theme.landingDark && { color: theme.accent }]}>Save</Text>}
          </TouchableOpacity>
        </View>

      </ScrollView>
    </View>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

// Tappable avatar with a camera badge overlay
function AvatarPicker({ avatarSource, name, onPress }) {
  return (
    <TouchableOpacity style={styles.avatarPickerWrapper} onPress={onPress} activeOpacity={0.8}>
      {avatarSource ? (
        <Image source={{ uri: avatarSource }} style={styles.setupAvatar} />
      ) : (
        <View style={[styles.setupAvatar, styles.setupAvatarPlaceholder]}>
          <Text style={styles.setupAvatarInitial}>
            {(name || '?')[0].toUpperCase()}
          </Text>
        </View>
      )}
      {/* Camera badge */}
      <View style={styles.cameraBadge}>
        <Text style={styles.cameraBadgeIcon}>📷</Text>
      </View>
    </TouchableOpacity>
  );
}

// Horizontal scrollable honorific chips
function HonorificsSelector({ value, onChange, accent = COLORS.primary }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 8 }}
      contentContainerStyle={styles.honorificsRow}
    >
      {HONORIFICS.map((h) => {
        const selected = value === h;
        return (
          <TouchableOpacity
            key={h === '' ? '__none__' : h}
            style={[styles.honorificChip, selected && { backgroundColor: accent, borderColor: accent }]}
            onPress={() => onChange(h)}
          >
            <Text style={[styles.honorificChipText, selected && styles.honorificChipTextSelected]}>
              {h === '' ? 'None' : h}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function FormField({ label, value, onChangeText, placeholder, keyboardType, accent = COLORS.primary, maxLength = 100 }) {
  return (
    <View style={styles.fieldWrapper}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, { borderColor: COLORS.border }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder || ''}
        placeholderTextColor={COLORS.textLight}
        keyboardType={keyboardType || 'default'}
        autoCapitalize="words"
        maxLength={maxLength}
        onFocus={(e) => { e.target.style && (e.target.style.borderColor = accent); }}
      />
    </View>
  );
}

// ─── vCard Builder ────────────────────────────────────────────────────────────
// M-4: Sanitize fields to prevent vCard injection via newlines or special chars
function sanitizeVCardField(str) {
  return (str || '').replace(/[\r\n]/g, ' ').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function buildVCard(profile, { companyName, photoBase64 } = {}) {
  const name = sanitizeVCardField(fullName(profile));
  const org = companyName || '';
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `N:${sanitizeVCardField(profile.name)};;;${sanitizeVCardField(profile.honorific || '')};`,
    `TITLE:${sanitizeVCardField(profile.title)}`,
    `ORG:${sanitizeVCardField(org)}${profile.dept ? `;${sanitizeVCardField(profile.dept)}` : ''}`,
    `EMAIL:${sanitizeVCardField(profile.email)}`,
  ];
  if (profile.phone) lines.push(`TEL;TYPE=CELL:${sanitizeVCardField(profile.phone)}`);
  if (photoBase64) {
    // Strip data URI prefix, fold at 75 chars per RFC 2425
    const raw = photoBase64.replace(/^data:image\/[^;]+;base64,/, '');
    const chunks = raw.match(/.{1,75}/g) || [];
    lines.push('PHOTO;ENCODING=b;TYPE=JPEG:' + chunks.join('\r\n '));
  }
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

// ─── Theme Picker ─────────────────────────────────────────────────────────────
function ThemePicker({ themes, currentTheme, onSelect, labelColor }) {
  const [open, setOpen] = useState(false);
  const currentDesc = currentTheme.subsidiary?.companyName || currentTheme.name;

  return (
    <View style={themePickerStyles.container}>
      <Text style={[themePickerStyles.label, { color: labelColor }]}>Theme</Text>

      {/* Trigger */}
      <TouchableOpacity style={themePickerStyles.trigger} onPress={() => setOpen(o => !o)}>
        <View style={[themePickerStyles.swatch, { backgroundColor: currentTheme.swatchColor }]} />
        <View style={themePickerStyles.textBlock}>
          <Text style={themePickerStyles.triggerName}>{currentTheme.name}</Text>
          <Text style={themePickerStyles.triggerDesc} numberOfLines={1}>{currentDesc}</Text>
        </View>
        <Text style={themePickerStyles.chevron}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {/* Dropdown list */}
      {open && (
        <View style={themePickerStyles.dropdown}>
          {themes.map((t, i) => {
            const selected = currentTheme.id === t.id;
            const companyName = t.subsidiary?.companyName || t.name;
            return (
              <TouchableOpacity
                key={t.id}
                style={[
                  themePickerStyles.option,
                  selected && { backgroundColor: '#F5F5F5' },
                  i < themes.length - 1 && themePickerStyles.optionBorder,
                ]}
                onPress={() => { onSelect(t); setOpen(false); }}
                accessibilityLabel={`${t.name} — ${companyName}`}
              >
                <View style={[themePickerStyles.swatch, { backgroundColor: t.swatchColor }]} />
                <View style={themePickerStyles.textBlock}>
                  <Text style={[themePickerStyles.optionName, selected && { color: t.accent }]}>{t.name}</Text>
                  <Text style={themePickerStyles.optionDesc} numberOfLines={1}>{companyName}</Text>
                </View>
                {selected && <Text style={[themePickerStyles.check, { color: t.accent }]}>✓</Text>}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const themePickerStyles = StyleSheet.create({
  container: {
    marginTop: 20,
    marginBottom: 4,
    width: '100%',
    zIndex: 10,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
  triggerName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 1,
  },
  triggerDesc: {
    fontSize: 11,
    color: '#888888',
  },
  chevron: {
    fontSize: 11,
    color: '#888888',
    marginLeft: 8,
  },
  dropdown: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    marginTop: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#FFFFFF',
  },
  optionBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E8E8E8',
  },
  optionName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 1,
  },
  optionDesc: {
    fontSize: 11,
    color: '#888888',
  },
  swatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    marginRight: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 1,
  },
  textBlock: {
    flex: 1,
  },
  check: {
    fontSize: 15,
    fontWeight: '800',
    marginLeft: 8,
  },
});

// ─── Corporate Card Styles ────────────────────────────────────────────────────
const corpStyles = StyleSheet.create({
  cardWrapper: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    paddingTop: 30,
    paddingBottom: 30,
    width: '100%',
  },
  cardContent: {
    flex: 1,
    padding: 18,
  },
  sideStrip: {
    width: 54,
    alignSelf: 'stretch',
    overflow: 'hidden',
  },
  name: {
    fontSize: 19,
    fontWeight: '800',
    color: '#E8231A',
    marginBottom: 5,
    lineHeight: 24,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333333',
    lineHeight: 22,
  },
  divider: {
    height: 1,
    backgroundColor: '#E8E8E8',
    marginVertical: 10,
  },
  email: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333333',
    marginBottom: 5,
  },
  phone: {
    fontSize: 16,
    fontWeight: '700',
    color: '#E8231A',
  },
  companyName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333333',
    marginBottom: 0,
  },
  address: {
    fontSize: 12,
    color: '#888888',
    lineHeight: 18,
  },
  website: {
    fontSize: 13,
    fontWeight: '600',
    color: '#E8231A',
    marginTop: 5,
  },
  qrBox: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E8E8E8',
  },
  shareBtn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDDDDD',
  },
});

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },

  // ── Login ────────────────────────────────────────────────────────────────
  loginContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  loginHero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 48,
    paddingBottom: 16,
  },
  loginHeroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 20,
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
  },
  heroTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#222222',
    letterSpacing: 3.5,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 12,
  },
  subsidiaryRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 6,
    width: '100%',
  },
  subsidiaryCell: {
    flex: 1,
    height: 36,
    backgroundColor: 'transparent',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 6,
  },
  subsidiaryLogo: {
    width: '100%',
    height: '100%',
  },
  loginCard: {
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 28,
    paddingBottom: 48,
  },
  loginHeading: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 8,
  },
  loginBody: {
    fontSize: 14,
    color: COLORS.textLight,
    lineHeight: 20,
    marginBottom: 24,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 24,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  googleIcon: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.primary,
    marginRight: 10,
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  loginNote: {
    fontSize: 12,
    color: COLORS.textLight,
    textAlign: 'center',
  },

  // ── Card View (Profile mode) ─────────────────────────────────────────────
  profileScrollContent: {
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 48,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 32,
  },
  topBarTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.text,
  },
  shareHeaderBtn: {
    backgroundColor: '#1A1A1A',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  shareHeaderBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  floatingCardContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  floatingAvatarRing: {
    zIndex: 2,
    marginBottom: -52,
    borderRadius: 56,
    borderWidth: 4,
    borderColor: COLORS.background,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6,
  },
  floatingAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  floatingAvatarPlaceholder: {
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  floatingAvatarInitial: {
    fontSize: 40,
    fontWeight: '700',
    color: '#fff',
  },
  contactCard: {
    width: '100%',
    backgroundColor: COLORS.card,
    borderRadius: 20,
    paddingTop: 68,
    paddingBottom: 24,
    paddingHorizontal: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
    alignItems: 'center',
  },
  contactName: {
    fontSize: 26,
    fontWeight: '800',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: 4,
  },
  contactJobTitle: {
    fontSize: 15,
    color: COLORS.textLight,
    textAlign: 'center',
    marginBottom: 2,
  },
  contactDivider: {
    width: '100%',
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 16,
  },
  contactLink: {
    fontSize: 15,
    color: COLORS.text,
    textDecorationLine: 'underline',
    textAlign: 'center',
    marginBottom: 6,
  },
  contactCompanyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'space-between',
  },
  contactCompanyName: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 2,
  },
  contactWebsite: {
    fontSize: 13,
    color: COLORS.textLight,
    textDecorationLine: 'underline',
  },

  // ── Gold buttons ─────────────────────────────────────────────────────────
  goldButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goldButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  goldButtonOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: COLORS.primary,
  },
  goldButtonOutlineText: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  signOutBtn: {
    alignItems: 'center',
    paddingVertical: 16,
    marginTop: 4,
  },
  signOutBtnText: {
    fontSize: 14,
    color: COLORS.error,
    fontWeight: '500',
  },

  // ── Gold Card View ───────────────────────────────────────────────────────
  goldScrollContent: {
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 48,
  },
  backBtn: {
    marginBottom: 24,
  },
  backBtnText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 15,
    fontWeight: '600',
  },
  cardWrapperOuter: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    marginBottom: 20,
    position: 'relative',
  },
  goldCardOuter: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  gearFloatRow: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 6,
  },
  gearBtn: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearBtnText: {
    fontSize: 20,
    color: '#333333',
  },
  cardViewBackBtn: {
    padding: 4,
  },
  cardViewBackBtnText: {
    fontSize: 22,
    fontWeight: '400',
  },
  goldCard: {
    backgroundColor: COLORS.primary,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    width: '100%',
  },
  goldCardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 28,
  },
  goldCardLogoPill: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  goldCardAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  goldCardAvatarPlaceholder: {
    backgroundColor: COLORS.primaryDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  goldCardAvatarInitial: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
  },
  goldCardJobTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  goldCardName: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 4,
  },
  goldCardDept: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.65)',
  },
  goldCardField: {
    marginBottom: 16,
  },
  goldCardFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.6)',
    letterSpacing: 1.5,
    marginBottom: 3,
  },
  goldCardFieldValue: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '400',
  },
  goldCardQRBox: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  whatsappBtn: {
    marginTop: 20,
    marginBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  whatsappBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  goldCardEditBtn: {
    marginTop: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  goldCardEditBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  // ── Profile Setup / Edit ─────────────────────────────────────────────────
  formScrollContent: {
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 48,
  },
  formHeader: {
    marginBottom: 24,
  },
  formHeaderTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: COLORS.text,
  },
  formHeaderSubtitle: {
    fontSize: 14,
    color: COLORS.textLight,
    marginTop: 4,
  },

  // Avatar picker
  avatarPickerWrapper: {
    alignSelf: 'center',
    marginBottom: 10,
    position: 'relative',
  },
  setupAvatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  setupAvatarPlaceholder: {
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  setupAvatarInitial: {
    fontSize: 34,
    fontWeight: '700',
    color: '#fff',
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#fff',
    borderRadius: 14,
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cameraBadgeIcon: {
    fontSize: 14,
  },

  emailTag: {
    textAlign: 'center',
    fontSize: 13,
    color: COLORS.textLight,
    marginBottom: 20,
  },
  formCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  fieldWrapper: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textLight,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
    fontSize: 15,
    color: COLORS.text,
    backgroundColor: '#FAFAF8',
  },
  editActionRow: {
    flexDirection: 'row',
  },

  // Honorific chips
  honorificsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
  },
  honorificChip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: '#FAFAF8',
  },
  honorificChipSelected: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  honorificChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textLight,
  },
  honorificChipTextSelected: {
    color: '#fff',
  },
});
