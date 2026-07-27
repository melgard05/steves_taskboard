/* Vikings Season Ticket Board — settings
   ---------------------------------------------------------------
   Edit this file once. Nothing else needs your database URL, and
   replacing index.html in future will not overwrite what's here.

   PASTE YOUR FIREBASE REALTIME DATABASE URL on the "db" line below.

   Copy it from the Firebase console: Realtime Database -> Data tab,
   the address shown across the top of the data viewer. It looks like

       https://vikings-tickets-default-rtdb.firebaseio.com

   or, if your database is outside the us-central1 region, like

       https://vikings-tickets-default-rtdb.us-east1.firebasedatabase.app

   Include the https:// part. The console sometimes displays the
   address without it, and without a scheme the browser looks for it
   on your own site instead of Firebase, which returns a 404.
   A trailing slash is fine. Leave it "" to run local-only.

   Leave "auth" empty unless your database rules require a token.
   Do not put a Firebase secret here — this file is publicly readable.
*/
window.VIKTIX_CONFIG = {
  db: "",
  auth: ""
};
