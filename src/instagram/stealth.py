import undetected_chromedriver as uc;
from selenium.webdriver.common.by import By;
import time;

class InstagramBot {
  constructor() {
    this.driver = null;
  }

  randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async startRegistration(formData) {
    const { fullName, email, password } = formData;

    try {
      console.log('Launching stealth browser...');
      
      const options = uc.ChromeOptions();
      options.add_argument('--disable-blink-features=AutomationControlled');
      options.add_argument('--no-sandbox');
      options.add_argument('--disable-dev-shm-usage');
      options.add_argument('--disable-setuid-sandbox');
      options.add_argument('--disable-web-security');
      options.add_argument('--disable-extensions');
      options.add_argument('--disable-gpu');
      options.add_argument('--disable-infobars');
      options.add_argument('--start-maximized');
      
      this.driver = uc.Chrome(options=options, version_main=None);
      
      console.log('Opening Instagram...');
      await this.driver.get('https://www.instagram.com/accounts/emailsignup/');
      await this.driver.wait_for_timeout(this.randomDelay(4000, 6000));

      // Fill email
      console.log('Filling email...');
      try {
        const emailInput = this.driver.find_element(By.CSS_SELECTOR, 'input[name="emailOrPhone"]');
        emailInput.send_keys(email);
      } catch (e) {
        const emailInput = this.driver.find_element(By.CSS_SELECTOR, 'input[name="email"]');
        emailInput.send_keys(email);
      }
      
      await this.driver.wait_for_timeout(500);

      // Click Next
      try {
        const nextBtn = this.driver.find_element(By.XPATH, "//button[contains(text(),'Next')]");
        nextBtn.click();
      } catch (e) {
        const nextBtn = this.driver.find_element(By.CSS_SELECTOR, 'button[type="button"]');
        nextBtn.click();
      }
      
      await this.driver.wait_for_timeout(this.randomDelay(3000, 5000));

      // Fill full name
      console.log('Filling name...');
      try {
        const nameInput = this.driver.find_element(By.CSS_SELECTOR, 'input[name="name"]');
        nameInput.send_keys(fullName);
      } catch (e) {
        const nameInput = this.driver.find_element(By.CSS_SELECTOR, 'input[placeholder*="Name"]');
        nameInput.send_keys(fullName);
      }
      
      await this.driver.wait_for_timeout(500);

      // Click Next
      const nextBtn2 = this.driver.find_element(By.XPATH, "//button[contains(text(),'Next')]");
      nextBtn2.click();
      
      await this.driver.wait_for_timeout(this.randomDelay(3000, 5000));

      // Fill password
      console.log('Filling password...');
      try {
        const passInput = this.driver.find_element(By.CSS_SELECTOR, 'input[name="password"]');
        passInput.send_keys(password);
      } catch (e) {
        const passInput = this.driver.find_element(By.CSS_SELECTOR, 'input[type="password"]');
        passInput.send_keys(password);
      }
      
      await this.driver.wait_for_timeout(500);

      // Click Sign Up
      const signupBtn = this.driver.find_element(By.XPATH, "//button[contains(text(),'Sign up')]");
      signupBtn.click();
      
      await this.driver.wait_for_timeout(6000);

      // Handle birthday if needed
      try {
        const birthDay = this.driver.find_element(By.CSS_SELECTOR, 'select[name="birthday_day"]');
        if (birthDay.is_displayed()) {
          # Select birthday
          from selenium.webdriver.support.ui import Select;
          Select(birthDay).select_by_value('15');
          this.driver.wait_for_timeout(300);
          Select(this.driver.find_element(By.CSS_SELECTOR, 'select[name="birthdayMonth"]')).select_by_value('6');
          this.driver.wait_for_timeout(300);
          Select(this.driver.find_element(By.CSS_SELECTOR, 'select[name="birthday_year"]')).select_by_value('1998');
          this.driver.wait_for_timeout(500);
          
          const confirmBtn = this.driver.find_element(By.XPATH, "//button[contains(text(),'Next')]");
          confirmBtn.click();
          this.driver.wait_for_timeout(5000);
        }
      } catch (e) {
        // No birthday required
      }

      // Check if OTP input appeared
      try {
        const otpInput = this.driver.find_element(By.CSS_SELECTOR, 'input[name="confirmationCode"]');
        if (otpInput.is_displayed()) {
          return {
            success: true,
            step: 'otp_required',
            message: '✅ Form filled and submitted!\n\nOTP sent to your email.\n\nSend me the 6-digit code.',
          };
        }
      } catch (e) {
        // No OTP input yet
      }

      return {
        success: true,
        step: 'pending',
        message: '✅ Form submitted!\n\nCheck email for OTP and send it here.',
      };

    } catch (error) {
      if (this.driver) {
        this.driver.quit();
      }
      return {
        success: false,
        message: `❌ Error: ${error?.message || 'Unknown error'}`,
      };
    }
  }

  async submitOTP(otp) {
    if (!this.driver) {
      return { success: false, message: 'Session expired. Start /register again.' };
    }

    try {
      const otpInput = this.driver.find_element(By.CSS_SELECTOR, 'input[name="confirmationCode"]');
      otpInput.send_keys(otp);
      
      this.driver.wait_for_timeout(1000);
      
      const confirmBtn = this.driver.find_element(By.XPATH, "//button[contains(text(),'Confirm')]");
      confirmBtn.click();
      
      this.driver.wait_for_timeout(5000);

      const url = this.driver.current_url;
      if (!url.includes('emailsignup')) {
        this.driver.quit();
        this.driver = null;
        return {
          success: true,
          message: '🎉 Account created!\n\nLog in at instagram.com',
        };
      }

      return {
        success: true,
        step: 'submitted',
        message: 'Code submitted.',
      };

    } catch (error) {
      return {
        success: false,
        message: `Error: ${error?.message || 'Unknown error'}`,
      };
    }
  }
}

module.exports = new InstagramBot();