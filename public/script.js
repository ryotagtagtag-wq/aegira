document.addEventListener('DOMContentLoaded', () => {
    const copyButton = document.getElementById('copy-button');
    const copyFeedback = document.getElementById('copy-feedback');
    const yearSpan = document.getElementById('year');

    // Set current year in footer
    if (yearSpan) {
        yearSpan.textContent = new Date().getFullYear();
    }

    // Scroll to instruction block when "Get started" button is clicked
    const getStartedButton = document.querySelector('a[href="#register"]');
    if (getStartedButton) {
        getStartedButton.addEventListener('click', (e) => {
            e.preventDefault();
            const instructionBlock = document.querySelector('.instruction-block');
            if (instructionBlock) {
                instructionBlock.scrollIntoView({ behavior: 'smooth' });
            }
        });
    }

    if (!copyButton || !copyFeedback) {
        return;
    }

    copyButton.addEventListener('click', async () => {
        const instructionText = document.querySelector('.instruction-block code').textContent;
        try {
            await navigator.clipboard.writeText(instructionText);
            copyFeedback.textContent = 'Copied';
            // Reset after 2 seconds
            setTimeout(() => {
                copyFeedback.textContent = '';
            }, 2000);
        } catch (err) {
            // Fallback: select the text and show message
            copyFeedback.textContent = 'Failed to copy. Select text below to copy.';
            const codeElement = document.querySelector('.instruction-block code');
            const range = document.createRange();
            range.selectNodeContents(codeElement);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            // Reset after 2 seconds
            setTimeout(() => {
                copyFeedback.textContent = '';
            }, 2000);
        }
    });
});
