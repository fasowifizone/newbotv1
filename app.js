const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configuration CORS étendue - Permet à tous les sites web d'accéder à l'API
app.use(cors({
    origin: '*', // Permet toutes les origines
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Variables globales
let browser = null;
let page = null;
let isAuthenticated = false;
let currentQRDataURL = null;
let connectionStatus = 'initializing';
let lastQRString = null;

// Configuration
const SESSION_FILE = '/app/session.json';
const USER_DATA_DIR = '/app/user_data';
const PORT = process.env.PORT || 3000;

// Sauvegarde de session
async function saveSession() {
    if (!page || !isAuthenticated) return;
    
    try {
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        const localStorage = await page.evaluate(() => {
            return JSON.stringify(window.localStorage);
        });
        
        const session = {
            cookies,
            localStorage,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
        console.log('✅ Session sauvegardée');
        return true;
    } catch (error) {
        console.error('Erreur sauvegarde session:', error);
        return false;
    }
}

// Chargement de session
async function loadSession() {
    if (!fs.existsSync(SESSION_FILE)) return false;
    
    try {
        const session = JSON.parse(fs.readFileSync(SESSION_FILE));
        
        if (page && session.cookies && session.cookies.length > 0) {
            const client = await page.target().createCDPSession();
            await client.send('Network.setCookies', {
                cookies: session.cookies
            });
            
            await page.evaluate((localStorageData) => {
                const storage = JSON.parse(localStorageData);
                Object.keys(storage).forEach(key => {
                    window.localStorage.setItem(key, storage[key]);
                });
            }, session.localStorage);
            
            console.log('✅ Session chargée');
            return true;
        }
    } catch (error) {
        console.error('Erreur chargement session:', error);
    }
    return false;
}

// Capture du QR Code
async function captureQRCode() {
    try {
        await page.waitForSelector('canvas', { timeout: 3000 }).catch(() => null);
        
        const qrElement = await page.$('canvas');
        if (qrElement) {
            const qrDataUrl = await page.evaluate(el => el.toDataURL(), qrElement);
            
            if (qrDataUrl && qrDataUrl !== currentQRDataURL) {
                currentQRDataURL = qrDataUrl;
                
                // Extraire le texte du QR code
                const qrText = await page.evaluate(() => {
                    const canvas = document.querySelector('canvas');
                    if (!canvas) return null;
                    
                    // Simuler l'extraction du texte (pour les besoins du frontend)
                    return 'qr_code_ready';
                });
                
                lastQRString = qrDataUrl;
                connectionStatus = 'qr_ready';
                console.log('📱 Nouveau QR code généré');
                return true;
            }
        } else {
            if (connectionStatus === 'qr_ready') {
                connectionStatus = 'waiting_for_scan';
            }
        }
    } catch (error) {
        // Silencieux
    }
    return false;
}

// Vérification authentification améliorée
async function checkAuthentication() {
    if (!page) return false;
    
    try {
        // Multiples vérificateurs pour être plus fiable
        const checks = await page.evaluate(() => {
            const checks = {
                hasChatIcon: !!document.querySelector('[data-testid="chat"]'),
                hasSidebar: !!document.querySelector('[data-testid="sidebar"]'),
                hasSearch: !!document.querySelector('[data-testid="chat-list-search"]'),
                hasChats: !!document.querySelector('[data-testid="conversation-info-header"]'),
                isLoggedIn: !!(document.querySelector('[data-testid="chat"]') || 
                              document.querySelector('[data-testid="sidebar"]') ||
                              document.querySelector('[data-testid="chat-list-search"]'))
            };
            return checks;
        });
        
        const loggedIn = checks.hasChatIcon || checks.hasSidebar || checks.hasSearch || checks.isLoggedIn;
        
        if (loggedIn && !isAuthenticated) {
            isAuthenticated = true;
            connectionStatus = 'authenticated';
            console.log('✅ WhatsApp authentifié!');
            await saveSession();
            
            // Récupérer les infos du compte
            const accountInfo = await getAccountInfo();
            console.log(`📱 Connecté en tant que: ${accountInfo.name || accountInfo.number || 'Utilisateur WhatsApp'}`);
            
        } else if (!loggedIn && isAuthenticated) {
            isAuthenticated = false;
            connectionStatus = 'disconnected';
            console.log('❌ Session expirée');
        } else if (!loggedIn && !isAuthenticated && connectionStatus !== 'qr_ready') {
            connectionStatus = 'waiting_for_qr';
        }
        
        return isAuthenticated;
    } catch (error) {
        console.error('Erreur vérification auth:', error);
        return false;
    }
}

// Récupérer infos du compte
async function getAccountInfo() {
    if (!page || !isAuthenticated) return null;
    
    try {
        const info = await page.evaluate(() => {
            // Essayer de trouver le nom du profil
            const profileName = document.querySelector('[data-testid="profile-name"]')?.textContent;
            const phoneNumber = document.querySelector('[data-testid="phone-number"]')?.textContent;
            
            return {
                name: profileName || null,
                number: phoneNumber || null,
                timestamp: new Date().toISOString()
            };
        });
        return info;
    } catch (error) {
        return null;
    }
}

// Envoi de message amélioré
async function sendMessage(phoneNumber, message) {
    if (!isAuthenticated || !page) {
        throw new Error('Non authentifié. Veuillez scanner le QR code d\'abord.');
    }
    
    // Nettoyer le numéro
    let cleanNumber = phoneNumber.toString().replace(/\s+/g, '');
    if (cleanNumber.startsWith('+')) {
        cleanNumber = cleanNumber.substring(1);
    }
    
    // Supprimer les caractères non numériques
    cleanNumber = cleanNumber.replace(/\D/g, '');
    
    if (cleanNumber.length < 10) {
        throw new Error('Numéro invalide. Doit contenir au moins 10 chiffres.');
    }
    
    const chatUrl = `https://web.whatsapp.com/send?phone=${cleanNumber}`;
    
    try {
        console.log(`📤 Envoi vers ${cleanNumber}...`);
        await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Attendre que le champ de texte soit disponible
        await page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 20000 });
        
        // Attendre un peu que l'interface se stabilise
        await page.waitForTimeout(1500);
        
        // Écrire le message
        const messageBox = await page.$('div[contenteditable="true"][data-tab="10"]');
        await messageBox.click();
        await messageBox.type(message);
        
        // Envoyer
        await page.keyboard.press('Enter');
        
        // Attendre confirmation
        await page.waitForTimeout(2000);
        
        console.log(`✅ Message envoyé à ${cleanNumber}`);
        return {
            success: true,
            message: 'Message envoyé avec succès',
            to: cleanNumber,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error(`❌ Erreur envoi à ${cleanNumber}:`, error);
        throw new Error(`Échec envoi: ${error.message}`);
    }
}

// Initialisation de WhatsApp
async function initWhatsApp() {
    try {
        console.log('🚀 Démarrage de WhatsApp Web...');
        
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--window-size=1280,800'
            ],
            userDataDir: USER_DATA_DIR,
            defaultViewport: { width: 1280, height: 800 }
        });
        
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        // Charger session existante
        const sessionLoaded = await loadSession();
        
        if (sessionLoaded) {
            console.log('📀 Session existante trouvée, tentative de reconnexion...');
        }
        
        await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Attendre que la page se charge
        await page.waitForTimeout(3000);
        
        // Vérifier l'authentification initiale
        await checkAuthentication();
        
        // Commencer la surveillance du QR code
        setInterval(() => {
            if (!isAuthenticated) {
                captureQRCode();
            }
        }, 2000);
        
        // Vérifier l'authentification régulièrement
        setInterval(async () => {
            await checkAuthentication();
        }, 5000);
        
        // Sauvegarder la session périodiquement
        setInterval(() => {
            if (isAuthenticated) {
                saveSession();
            }
        }, 30000); // Toutes les 30 secondes
        
        console.log('✅ WhatsApp Web prêt');
        connectionStatus = isAuthenticated ? 'authenticated' : 'waiting_for_qr';
        
    } catch (error) {
        console.error('❌ Erreur initialisation:', error);
        connectionStatus = 'error';
    }
}

// ============ ROUTES API ============

// Route 1: Obtenir le QR code (format image base64 ou JSON)
app.get('/api/qr', async (req, res) => {
    try {
        if (isAuthenticated) {
            return res.json({
                success: true,
                authenticated: true,
                message: 'Déjà connecté',
                status: 'authenticated'
            });
        }
        
        if (currentQRDataURL) {
            // Retourner le QR code en base64
            const qrBase64 = currentQRDataURL.split(',')[1];
            res.json({
                success: true,
                authenticated: false,
                qrCode: qrBase64,
                qrImageUrl: currentQRDataURL,
                status: 'qr_ready'
            });
        } else {
            res.json({
                success: false,
                authenticated: false,
                message: 'QR code en cours de génération...',
                status: connectionStatus
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route 2: Vérifier le statut
app.get('/api/status', async (req, res) => {
    res.json({
        success: true,
        authenticated: isAuthenticated,
        status: connectionStatus,
        timestamp: new Date().toISOString(),
        message: isAuthenticated ? 'Connecté à WhatsApp' : 'En attente de connexion'
    });
});

// Route 3: Envoyer un message
app.post('/api/send', async (req, res) => {
    const { phone, message } = req.body;
    
    // Validation
    if (!phone || !message) {
        return res.status(400).json({
            success: false,
            error: 'Les champs "phone" et "message" sont requis'
        });
    }
    
    if (message.length > 65536) {
        return res.status(400).json({
            success: false,
            error: 'Message trop long'
        });
    }
    
    try {
        const result = await sendMessage(phone, message);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route 4: Obtenir les infos du compte (si connecté)
app.get('/api/account', async (req, res) => {
    if (!isAuthenticated) {
        return res.json({
            success: false,
            authenticated: false,
            message: 'Non authentifié'
        });
    }
    
    const accountInfo = await getAccountInfo();
    res.json({
        success: true,
        authenticated: true,
        ...accountInfo
    });
});

// Route 5: Déconnexion (ne supprime pas la session, juste l'état)
app.post('/api/logout', async (req, res) => {
    try {
        if (page) {
            await page.goto('https://web.whatsapp.com');
            isAuthenticated = false;
            connectionStatus = 'logged_out';
            currentQRDataURL = null;
            res.json({
                success: true,
                message: 'Déconnecté avec succès'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route 6: Reset complet (supprime la session)
app.post('/api/reset', async (req, res) => {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            fs.unlinkSync(SESSION_FILE);
        }
        
        isAuthenticated = false;
        connectionStatus = 'reset';
        currentQRDataURL = null;
        
        // Relancer l'initialisation
        if (browser) {
            await browser.close();
        }
        setTimeout(() => initWhatsApp(), 1000);
        
        res.json({
            success: true,
            message: 'Session réinitialisée'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route racine - Info API
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp API Server',
        version: '2.0.0',
        endpoints: {
            'GET /api/qr': 'Obtenir le QR code (format JSON avec base64)',
            'GET /api/status': 'Vérifier le statut de connexion',
            'POST /api/send': 'Envoyer un message (body: {phone, message})',
            'GET /api/account': 'Obtenir les infos du compte WhatsApp',
            'POST /api/logout': 'Se déconnecter',
            'POST /api/reset': 'Réinitialiser la session'
        },
        cors_enabled: true,
        status: connectionStatus,
        authenticated: isAuthenticated
    });
});

// Démarrer le serveur
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur API démarré sur le port ${PORT}`);
    console.log(`🔗 API accessible depuis n'importe quel site web (CORS activé)`);
    console.log(`📱 Commencer l'initialisation de WhatsApp...`);
    initWhatsApp();
});

// Nettoyage
process.on('SIGINT', async () => {
    console.log('🛑 Arrêt du serveur...');
    if (isAuthenticated) {
        await saveSession();
    }
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});
