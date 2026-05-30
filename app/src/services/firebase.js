import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// This **IS** okay to be public !!!
const firebaseConfig = {

  apiKey: "AIzaSyBrECdxMrbjPWWFkTu_Riqo2s1dbSVfjvM",

  authDomain: "folkfriend-petrush-fork.firebaseapp.com",

  projectId: "folkfriend-petrush-fork",

  storageBucket: "folkfriend-petrush-fork.firebasestorage.app",

  messagingSenderId: "253027926478",

  appId: "1:253027926478:web:08b816f209f93809de2b9f",

  measurementId: "G-7WY6R8QZVD"

};

const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export default firebaseApp;
