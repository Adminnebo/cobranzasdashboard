// Holder del access_token para que api.js lo adjunte sin acoplarse a React.
let _token = null;
export const setAuthToken = (t) => { _token = t || null; };
export const getAuthToken = () => _token;
