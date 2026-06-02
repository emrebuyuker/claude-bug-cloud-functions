import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize the Admin SDK exactly once across all function modules. Writes made
// through this `db` handle bypass Firestore security rules (admin privileges), so
// clients can be locked to read-only on the `bugJobs` collection.
if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
