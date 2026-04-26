const express = require('express');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static('public'));

let browser = null;
let page = null;
let isAuthenticated = false;
let currentQR = null;
let qrCodeGeneration = null;

// Configuration
const SESSION_FILE = '/app/session.json';
const USER_DATA_DIR = '/app/user_data';

// Fonction pour sauvegarder la session
async function saveSession() {
    if (page) {
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        const localStorage = await page.evaluate(() => {
            return JSON.stringify(window.localStorage);
        });
        
        const session = { cookies, localStorage };
        fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
        console.log('Session sauvegardée');
    }
}

// Fonction pour charger la session
async function loadSession() {
    if (fs.existsSync(SESSION_FILE)) {
        const session = JSON.parse(fs.readFileSync(SESSION_FILE));
        
        if (page && session.cookies) {
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
            
            console.log('Session chargée');
            return true;
        }
    }
    return false;
}

// Initialiser WhatsApp Web
async function initWhatsApp() {
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            userDataDir: USER_DATA_DIR
        });

        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        // Charger session précédente
        await loadSession();
        
        await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle2' });
        
        // Vérifier si déjà authentifié
        await checkAuthentication();
        
        // Surveiller les changements de QR code
        await page.setViewport({ width: 1280, height: 800 });
        
        // Écouter les événements de la page
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        
        // Fonction pour capturer le QR code
        await captureQRCode();
        
        // Vérifier périodiquement l'authentification
        setInterval(checkAuthentication, 5000);
        
        // Sauvegarder la session toutes les minutes
        setInterval(() => {
            if (isAuthenticated) {
                saveSession();
            }
        }, 60000);
        
    } catch (error) {
        console.error('Erreur lors de l\'initialisation:', error);
    }
}

// Capturer le QR code
async function captureQRCode() {
    try {
        // Attendre que le QR code apparaisse
        await page.waitForSelector('canvas', { timeout: 5000 }).catch(() => null);
        
        const qrElement = await page.$('canvas');
        if (qrElement) {
            const qrDataUrl = await page.evaluate(el => el.toDataURL(), qrElement);
            if (qrDataUrl && qrDataUrl !== currentQR) {
                currentQR = qrDataUrl;
                console.log('Nouveau QR code généré');
            }
        }
    } catch (error) {
        console.log('QR code non trouvé, en attente...');
    }
}

// Vérifier l'authentification
async function checkAuthentication() {
    if (!page) return false;
    
    try {
        // Vérifier si l'utilisateur est connecté
        const isLoggedIn = await page.evaluate(() => {
            const checkElements = () => {
                // Vérifier la présence de l'icône de chat ou de la sidebar
                const chatIcon = document.querySelector('[data-testid="chat"]');
                const sidebar = document.querySelector('[data-testid="sidebar"]');
                const searchInput = document.querySelector('[data-testid="chat-list-search"]');
                return !!(chatIcon || sidebar || searchInput);
            };
            return checkElements();
        });
        
        if (isLoggedIn && !isAuthenticated) {
            isAuthenticated = true;
            console.log('✅ Authentification réussie!');
            await saveSession();
        } else if (!isLoggedIn && isAuthenticated) {
            isAuthenticated = false;
            console.log('❌ Session expirée');
        }
        
        return isAuthenticated;
    } catch (error) {
        console.error('Erreur vérification authentification:', error);
        return false;
    }
}

// Envoyer un message
async function sendMessage(phoneNumber, message) {
    if (!isAuthenticated || !page) {
        throw new Error('Non authentifié');
    }
    
    // Formater le numéro (supprimer le + et espaces)
    let formattedNumber = phoneNumber.toString().replace(/\s/g, '');
    if (formattedNumber.startsWith('+')) {
        formattedNumber = formattedNumber.substring(1);
    }
    
    const chatUrl = `https://web.whatsapp.com/send?phone=${formattedNumber}`;
    
    try {
        await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Attendre que le champ de message soit disponible
        await page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 15000 });
        
        // Écrire le message
        await page.click('div[contenteditable="true"][data-tab="10"]');
        await page.type('div[contenteditable="true"][data-tab="10"]', message);
        
        // Appuyer sur Entrée pour envoyer
        await page.keyboard.press('Enter');
        
        // Attendre que le message soit envoyé
        await page.waitForTimeout(2000);
        
        return { success: true, message: 'Message envoyé avec succès' };
    } catch (error) {
        console.error('Erreur envoi message:', error);
        throw new Error(`Erreur d'envoi: ${error.message}`);
    }
}

// Routes Express
app.get('/', async (req, res) => {
    if (isAuthenticated) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Connecté</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    .success { color: green; font-size: 24px; }
                    button { padding: 10px 20px; font-size: 16px; margin-top: 20px; cursor: pointer; }
                    .status { margin-top: 20px; padding: 10px; background: #f0f0f0; border-radius: 5px; }
                </style>
            </head>
            <body>
                <div class="success">✅ WhatsApp est connecté!</div>
                <div class="status">Session active et prête à envoyer des messages</div>
                <button onclick="window.location.href='/status'">Vérifier le statut</button>
                <div style="margin-top: 20px;">
                    <h3>Envoyer un message:</h3>
                    <form id="sendForm">
                        <input type="text" id="phone" placeholder="Numéro (ex: 33612345678)" required><br><br>
                        <textarea id="message" placeholder="Votre message" required></textarea><br><br>
                        <button type="submit">Envoyer</button>
                    </form>
                    <div id="result"></div>
                </div>
                <script>
                    document.getElementById('sendForm').onsubmit = async (e) => {
                        e.preventDefault();
                        const phone = document.getElementById('phone').value;
                        const message = document.getElementById('message').value;
                        const result = document.getElementById('result');
                        
                        result.innerHTML = 'Envoi en cours...';
                        
                        const response = await fetch('/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone, message })
                        });
                        
                        const data = await response.json();
                        if (data.success) {
                            result.innerHTML = '<span style="color:green">✅ Message envoyé!</span>';
                        } else {
                            result.innerHTML = '<span style="color:red">❌ Erreur: ' + data.error + '</span>';
                        }
                    };
                </script>
            </body>
            </html>
        `);
    } else if (currentQR) {
        // Afficher le QR code
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp QR Code</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    .qr-container { margin: 20px auto; }
                    .instructions { color: #666; margin-top: 20px; }
                    .refresh { margin-top: 20px; }
                    button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
                </style>
                <meta http-equiv="refresh" content="5">
            </head>
            <body>
                <h1>Scanner le QR Code</h1>
                <div class="qr-container">
                    <img src="${qrImage}" alt="QR Code">
                </div>
                <div class="instructions">
                    Ouvrez WhatsApp sur votre téléphone → Menu → WhatsApp Web → Scannez ce code
                </div>
                <div class="refresh">
                    <button onclick="window.location.reload()">Rafraîchir</button>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp - En attente</title>
                <meta http-equiv="refresh" content="3">
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    .loading { color: #666; }
                </style>
            </head>
            <body>
                <h1>Chargement de WhatsApp Web...</h1>
                <div class="loading">Veuillez patienter, génération du QR code en cours</div>
            </body>
            </html>
        `);
    }
});

app.get('/status', (req, res) => {
    res.json({
        authenticated: isAuthenticated,
        qrAvailable: !!currentQR,
        timestamp: new Date().toISOString()
    });
});

app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Numéro et message requis' 
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

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    initWhatsApp();
});

// Gestion propre de l'arrêt
process.on('SIGINT', async () => {
    console.log('Arrêt du serveur...');
    if (isAuthenticated) {
        await saveSession();
    }
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});
