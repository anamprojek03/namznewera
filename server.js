/**
 * NAMZ XITER — Optimized Backend Server
 * Fitur: Validasi Stok Otomatis, Auto-License, & Pakasir Integration
 */
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path')
const app = express();

// --- CONFIGURASI ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(__dirname));

const DB_FILE = './database.json';
const USERS_FILE = './users.json';

// --- CONFIGURASI API PAKASIR ---
// Disarankan menggunakan variabel di admin atau .env, namun ini sesuai kode Anda
const PAKASIR_SLUG = 'namznew'; 
const PAKASIR_API_KEY = 'DCtFgQ2wM24EBSV528Sochh3bBM7v7d5';

// Inisialisasi File jika belum ada
function initFiles() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({
            products: [],
            orders: [],
            settings: { 
                shopName: "NAMZ XITER", 
                pakasirMerchantId: "namznew", 
                pakasirApiKey: "DCtFgQ2wM24EBSV528Sochh3bBM7v7d5" 
            }
        }, null, 2));
    }
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: "admin", password: "123", role: "admin" }], null, 2));
    }
}
initFiles();

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// --- ROUTE HALAMAN UTAMA ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));
app.get('/product', (req, res) => res.sendFile(path.join(__dirname, 'product.html')));

// --- API ROUTES ---

// 1. Ambil & Simpan Database
app.get('/api/db', (req, res) => res.json(readJSON(DB_FILE)));
app.post('/api/db', (req, res) => {
    writeJSON(DB_FILE, req.body);
    res.json({ success: true });
});

// 2. Auth Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ message: "Login Berhasil", role: user.role, user: user.username });
    } else {
        res.status(401).json({ message: "Username atau Password Salah!" });
    }
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const users = readJSON(USERS_FILE);

    // Cek apakah username sudah ada
    const userExists = users.find(u => u.username === username);
    if (userExists) {
        return res.status(400).json({ message: "Username sudah terdaftar!" });
    }

    // Simpan user baru
    users.push({ username, password, role: "user" });
    writeJSON(USERS_FILE, users);

    res.json({ message: "Pendaftaran Berhasil! Silakan Login.", user: username, role: "user" });
});

// 3. Buat Pesanan (Dengan Validasi Stok)
app.post('/api/pay', async (req, res) => {
    const { productId, packageId, buyerName } = req.body;
    const db = readJSON(DB_FILE);
    
    const product = db.products.find(p => p.id === productId);
    const pkg = product?.packages.find(p => p.id === packageId);

    if (!pkg || !pkg.licenses || pkg.licenses.length === 0) {
        return res.status(400).json({ error: 'Maaf, stok lisensi untuk paket ini sedang habis!' });
    }

    const orderId = 'INV-' + Date.now();

    try {
        const response = await axios.post(`https://api.pakasir.id/v1/merchant/${PAKASIR_SLUG}/create-order`, {
            external_id: orderId,
            amount: pkg.price,
            payment_method: 'QRIS',
            callback_url: `${req.protocol}://${req.get('host')}/api/webhook/pakasir`
        }, {
            // PAKAI VARIABEL YANG SUDAH DIBUAT DI ATAS
            headers: { 'X-Api-Key': PAKASIR_API_KEY }
        });

        db.orders.push({
            id: orderId,
            productId,
            productName: product.name,
            packageId,
            packageName: pkg.name,
            price: pkg.price,
            buyer: buyerName,
            status: 'PENDING',
            license: '',
            date: new Date().toLocaleString('id-ID')
        });
        writeJSON(DB_FILE, db);

        res.json({ 
            success: true,
            orderId, 
            qr_url: response.data.data.qr_url 
        });

    } catch (error) {
        // Ini buat liat detail error di terminal kalau masih gagal
        console.error("Pakasir Error:", error.response?.data || error.message);
        res.status(500).json({ error: 'Gagal membuat QRIS. Coba lagi nanti.' });
    }
});

// 4. Webhook (Otomatis Kirim Lisensi & Potong Stok)
app.post('/api/webhook/pakasir', (req, res) => {
    const { external_id, status } = req.body;
    const db = readJSON(DB_FILE);
    const order = db.orders.find(o => o.id === external_id);

    // Pastikan order ada dan masih pending
    if (order && order.status === 'PENDING' && (status === 'COMPLETED' || status === 'PAID')) {
        const product = db.products.find(p => p.id === order.productId);
        const pkg = product?.packages.find(p => p.id === order.packageId);

        // Validasi stok sekali lagi saat pembayaran masuk
        if (pkg && pkg.licenses && pkg.licenses.length > 0) {
            // AMBIL LISENSI (Shift mengambil elemen pertama dan menghapusnya dari array)
            const getLicense = pkg.licenses.shift(); 
            
            order.status = 'SUCCESS';
            order.license = getLicense;
            
            console.log(`[SUCCESS] Order ${external_id} Berhasil. Lisensi dikirim.`);
            writeJSON(DB_FILE, db);
        } else {
            // Jika ternyata stok habis tepat saat user bayar
            order.status = 'MANUAL_PROCESS';
            order.license = 'STOK HABIS - HUBUNGI ADMIN';
            writeJSON(DB_FILE, db);
            console.error(`[ERROR] Order ${external_id} PAID tapi stok habis!`);
        }
    }
    
    res.sendStatus(200); // Pakasir butuh respon 200 OK
});

// 5. Check Status (Untuk Polling di Frontend)
app.get('/api/order/:id', (req, res) => {
    const db = readJSON(DB_FILE);
    const order = db.orders.find(o => o.id === req.params.id);
    
    if (!order) {
        return res.status(404).json({ status: 'NOT_FOUND' });
    }

    res.json({
        status: order.status,
        license: order.license
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`NAMZ XITER SERVER IS ACTIVE`);
    console.log(`Port: ${PORT}`);
    console.log(`Server running on port ${PORT}`);
    console.log(`=================================`);
});