const admin = require('firebase-admin');

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

let firebaseAdmin = null;

try {
  if (serviceAccount.projectId && serviceAccount.privateKey && serviceAccount.clientEmail) {
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin initialized');
  }
} catch (error) {
  console.error('Firebase init error:', error.message);
}

const verifyFirebaseToken = async (idToken) => {
  if (!firebaseAdmin) return null;
  try {
    return await firebaseAdmin.auth().verifyIdToken(idToken);
  } catch (error) {
    console.error('Token verification error:', error.message);
    return null;
  }
};

module.exports = { admin: firebaseAdmin, verifyFirebaseToken };
