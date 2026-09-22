const Message = {
  async send(params) {
    try {
      const response = await fetch('/api/send-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
      });
      return await response.json();
    } catch (error) {
      console.error('Send message failed:', error);
      throw error;
    }
  },
  
  init() {
    const form = document.getElementById('messageForm');
    if (!form) return;

    const channelCheckboxes = document.querySelectorAll('input[name="channels"]');
    const emailBodyContainer = document.getElementById('emailBodyGroup');
    
    // Toggle visibility based on channel
    channelCheckboxes.forEach(cb => {
      cb.addEventListener('change', () => {
        const isEmailChecked = document.querySelector('input[name="channels"][value="email"]')?.checked;
        if (emailBodyContainer) {
          emailBodyContainer.style.display = isEmailChecked ? 'block' : 'none';
        }
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const channels = Array.from(document.querySelectorAll('input[name="channels"]:checked')).map(cb => cb.value);
      const recipientType = document.querySelector('input[name="recipientType"]:checked')?.value || 'toAd';
      const recipientsStr = document.getElementById('recipients')?.value || '';
      const subject = document.getElementById('msgSubject')?.value || '';
      const message = document.getElementById('msgText')?.value || '';
      const email_body = document.getElementById('emailBody')?.value || '';

      // Validation
      if (!subject) {
        window.App?.showToast('กรุณาระบุหัวข้อ', 'warning');
        return;
      }

      if (channels.includes('email') || channels.includes('hr_mobile')) {
        if (!email_body && !message) {
          window.App?.showToast('กรุณาระบุเนื้อหาอีเมลหรือข้อความ', 'warning');
          return;
        }
      }

      if (!recipientsStr) {
        window.App?.showToast('กรุณาระบุผู้รับอย่างน้อยหนึ่งคน', 'warning');
        return;
      }

      const recipientsArray = recipientsStr.split(',').map(s => s.trim()).filter(Boolean);
      const toArray = recipientType === 'to' ? recipientsArray : [];
      const toAdArray = recipientType === 'toAd' ? recipientsArray : [];

      if ((channels.includes('line') || channels.includes('hr_mobile')) && toAdArray.length === 0) {
        window.App?.showToast('LINE และ HR Mobile ต้องระบุผู้รับเป็น AD Username', 'warning');
        return;
      }

      const params = {
        channel: channels,
        to: toArray,
        toAd: toAdArray,
        subject,
        message,
        email_body
      };

      const btn = form.querySelector('button[type="submit"]');
      window.App?.setLoading(btn, true);

      try {
        const result = await this.send(params);
        if (result && (result.status === 'success' || result.status === 'partial')) {
          const toastType = result.status === 'success' ? 'success' : 'warning';
          const toastMsg = result.status === 'success' ? 'ส่งข้อความสำเร็จ' : 'ส่งข้อความสำเร็จบางส่วน';
          window.App?.showToast(toastMsg, toastType);
          
          const resultCard = document.getElementById('messageResult');
          const resultContent = document.getElementById('messageResultContent');
          if (resultCard && resultContent) {
            resultCard.style.display = 'block';
            const sentLines = Array.isArray(result.message) ? result.message.join('<br>') : (result.message || '');
            const errorLines = Array.isArray(result.errors) ? result.errors.join('<br>') : '';
            resultContent.innerHTML = `
              <div><strong>Tracking ID:</strong> ${result.tracking_id || '-'}</div>
              ${sentLines ? `<div class="mt-2">${sentLines}</div>` : ''}
              ${errorLines ? `<div class="mt-2 text-danger">${errorLines}</div>` : ''}
            `;
          }
        } else {
          window.App?.showToast('ส่งข้อความล้มเหลว', 'error');
        }
      } catch (err) {
        window.App?.showToast('เกิดข้อผิดพลาดในการส่งข้อความ', 'error');
      } finally {
        window.App?.setLoading(btn, false);
      }
    });
  }
};
window.Message = Message;
