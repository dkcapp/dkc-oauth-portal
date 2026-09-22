const Auth = {
  user: null,

  async checkSession() {
    try {
      const response = await fetch('/auth/me');
      if (response.ok) {
        const data = await response.json();
        this.setUser(data);
        return data;
      }
    } catch (error) {
      console.error('Session check failed:', error);
    }
    return null;
  },
  
  login() {
    window.location.href = '/auth/login';
  },
  
  logout() {
    window.location.href = '/auth/logout';
  },
  
  getUser() {
    return this.user;
  },
  
  setUser(data) {
    this.user = data;
  }
};

window.Auth = Auth;

// ผูก Event Listener ให้กับปุ่ม Login ถ้าอยู่ในหน้า index.html
document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      Auth.login();
    });
  }
});
