const App = {
  currentSection: 'profile',
  
  async init() {
    const user = await window.Auth?.checkSession();
    if (!user) {
      window.location.href = '/index.html';
      return;
    }
    
    this.populateUserInfo(user);
    this.initNavigation();
    window.Message?.init();
    window.Approval?.init();
    this.initMobileMenu();
    this.showSection(this.currentSection);
  },
  
  showSection(sectionName) {
    this.currentSection = sectionName;
    const sections = document.querySelectorAll('.app-section');
    sections.forEach(sec => {
      sec.style.display = (sec.id === `section-${sectionName}`) ? 'block' : 'none';
    });

    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      if (item.dataset.section === sectionName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  },
  
  populateUserInfo(user) {
    const navName = document.getElementById('navDisplayName');
    if (navName) navName.textContent = user.display_name || user.name || 'ผู้ใช้งาน';

    const profileName = document.getElementById('profileName');
    if (profileName) profileName.textContent = user.display_name || user.name || '-';

    const profileUsername = document.getElementById('profileUsername');
    if (profileUsername) profileUsername.textContent = user.username ? `Username: ${user.username}` : '-';

    const profileEmail = document.getElementById('profileEmail');
    if (profileEmail) profileEmail.textContent = user.email || '-';

    const officesContainer = document.getElementById('officesContainer');
    if (officesContainer && Array.isArray(user.offices)) {
      officesContainer.innerHTML = user.offices.map(office => `
        <div class="office-card">
          <p><strong>ตำแหน่ง:</strong> ${office.position || '-'}</p>
          <p><strong>กอง:</strong> ${office.kong || '-'}</p>
          <p><strong>ฝ่าย:</strong> ${office.section || '-'}</p>
          <p><strong>สำนัก:</strong> ${office.samnak || '-'}</p>
        </div>
      `).join('');
    }
  },
  
  initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const section = item.dataset.section;
        if (section) {
          this.showSection(section);
          
          // Mobile close sidebar
          const sidebar = document.getElementById('sidebar');
          if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
          }
        }
      });
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        window.Auth?.logout();
      });
    }
  },
  
  initMobileMenu() {
    const menuToggle = document.getElementById('mobile-menu-toggle');
    const sidebar = document.getElementById('sidebar');
    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }
  },
  
  showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.position = 'fixed';
      container.style.top = '20px';
      container.style.right = '20px';
      container.style.zIndex = '9999';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.padding = '12px 16px';
    toast.style.marginBottom = '10px';
    toast.style.borderRadius = '4px';
    toast.style.color = '#fff';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.justifyContent = 'space-between';
    toast.style.minWidth = '250px';
    toast.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';

    let bgColor = '#4caf50';
    if (type === 'error') bgColor = '#f44336';
    if (type === 'warning') bgColor = '#ff9800';
    if (type === 'info') bgColor = '#2196f3';
    toast.style.backgroundColor = bgColor;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = window.Icons ? window.Icons.close(16) : 'X';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.color = '#fff';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.marginLeft = '16px';
    closeBtn.addEventListener('click', () => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 5000);
  },
  
  setLoading(buttonEl, loading) {
    if (!buttonEl) return;
    if (loading) {
      buttonEl.disabled = true;
      buttonEl.dataset.originalText = buttonEl.innerHTML;
      buttonEl.innerHTML = (window.Icons ? window.Icons.pending(16) : '...') + ' กำลังดำเนินการ...';
    } else {
      buttonEl.disabled = false;
      buttonEl.innerHTML = buttonEl.dataset.originalText || 'ตกลง';
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;
