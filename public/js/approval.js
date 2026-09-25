const Approval = {
  async submitRequest(params) {
    try {
      const response = await fetch('/api/cas/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return await response.json();
    } catch (error) {
      console.error('Submit approval failed:', error);
      throw error;
    }
  },

  async checkStatus(params) {
    try {
      const response = await fetch('/api/cas/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return await response.json();
    } catch (error) {
      console.error('Check status failed:', error);
      throw error;
    }
  },

  init() {
    const submitForm = document.getElementById('approvalForm');
    if (submitForm) {
      submitForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const ExternalRefID = document.getElementById('extRefId')?.value;
        const ApproveType = document.querySelector('input[name="approveType"]:checked')?.value;
        const MsgSubject = document.getElementById('apprSubject')?.value;
        const MsgForHead = document.getElementById('msgForHead')?.value;

        if (!ExternalRefID) {
          window.App?.showToast('กรุณาระบุหมายเลขอ้างอิง', 'warning');
          return;
        }

        const btn = submitForm.querySelector('button[type="submit"]');
        window.App?.setLoading(btn, true);

        try {
          const result = await this.submitRequest({ ExternalRefID, ApproveType, MsgSubject, MsgForHead });
          if (result && !result.error) {
            window.App?.showToast('ส่งคำขออนุมัติสำเร็จ', 'success');
            const resultCard = document.getElementById('approvalResult');
            const resultContent = document.getElementById('approvalResultContent');
            if (resultCard && resultContent) {
              resultCard.style.display = 'block';
              resultContent.innerHTML = `
                <div><strong>ผู้อนุมัติ:</strong> ${result.ApproverName || '-'}</div>
                <div><strong>ตำแหน่ง:</strong> ${result.ApproverPosition || '-'}</div>
                <div><strong>หน่วยงาน:</strong> ${result.ApproverOrg || '-'}</div>
                <div><strong>อีเมล:</strong> ${result.ApproverEmail || '-'}</div>
              `;
            }
          } else {
            window.App?.showToast('ส่งคำขออนุมัติล้มเหลว', 'error');
          }
        } catch (err) {
          window.App?.showToast('เกิดข้อผิดพลาดในการส่งคำขอ', 'error');
        } finally {
          window.App?.setLoading(btn, false);
        }
      });
    }

    const statusForm = document.getElementById('checkStatusForm');
    if (statusForm) {
      statusForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const ExternalRefID = document.getElementById('checkExtRefId')?.value;
        if (!ExternalRefID) {
          window.App?.showToast('กรุณาระบุหมายเลขอ้างอิง', 'warning');
          return;
        }

        const btn = statusForm.querySelector('button[type="submit"]');
        window.App?.setLoading(btn, true);

        try {
          const result = await this.checkStatus({ ExternalRefID });
          if (result && !result.error) {
            const resultCard = document.getElementById('statusResult');
            if (resultCard) {
              resultCard.style.display = 'block';
              
              let statusBadge = '';
              const statusUpper = (result.Status || '').toUpperCase();
              if (statusUpper === 'PENDING') statusBadge = `<span style="color:orange;font-weight:bold;">รอดำเนินการ (PENDING)</span>`;
              else if (statusUpper === 'APPROVE') statusBadge = `<span style="color:green;font-weight:bold;">อนุมัติแล้ว (APPROVE)</span>`;
              else if (statusUpper === 'REJECT') statusBadge = `<span style="color:red;font-weight:bold;">ปฏิเสธ (REJECT)</span>`;
              else statusBadge = `<span>${result.Status || '-'}</span>`;

              resultCard.innerHTML = `
                <div><strong>สถานะ:</strong> ${statusBadge}</div>
                <div><strong>ขั้นตอน:</strong> ${result.ApproveStep || '-'}</div>
                <div><strong>ผู้อนุมัติ (AD):</strong> ${result.Approver_ADUser || '-'}</div>
                <div><strong>เวลาสร้าง:</strong> ${result.CreateDate || '-'}</div>
                <div><strong>เวลาตอบกลับ:</strong> ${result.ActionDate || '-'}</div>
              `;
            }
            window.App?.showToast('ตรวจสอบสถานะสำเร็จ', 'success');
          } else {
            window.App?.showToast('ตรวจสอบสถานะล้มเหลว', 'error');
          }
        } catch (err) {
          window.App?.showToast('เกิดข้อผิดพลาดในการตรวจสอบสถานะ', 'error');
        } finally {
          window.App?.setLoading(btn, false);
        }
      });
    }
  }
};
window.Approval = Approval;
